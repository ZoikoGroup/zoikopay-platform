//go:build integration

package http_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/audit"
	"github.com/zoiko/zoikopay/internal/platform/ids"
)

// row is one audit entry as stored, read by the superuser for assertions.
type row struct {
	TraceID, Environment, Action, Outcome string
	Issuer, Subject, Tenant               *string
	ResourceType, ResourceHash, Reason    *string
	Status                                int
	At                                    time.Time
}

func (g *gateway) entries(t *testing.T) map[string]row {
	t.Helper()
	rows, err := g.su.Query(t.Context(), `SELECT trace_id, environment, action, outcome, actor_issuer, actor_subject, tenant_id,
		resource_type, resource_hash, reason, http_status, occurred_at_utc FROM governance.audit_events`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]row{}
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.TraceID, &r.Environment, &r.Action, &r.Outcome, &r.Issuer, &r.Subject, &r.Tenant,
			&r.ResourceType, &r.ResourceHash, &r.Reason, &r.Status, &r.At); err != nil {
			t.Fatal(err)
		}
		out[r.TraceID] = r
	}
	return out
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// TestAuditTrail drives the gateway and checks governance.audit_events
// (OPEN_QUESTIONS Q38): one entry per request with who, what, when, tenant,
// outcome and trace ID; denials recorded without revealing other tenants;
// no token stored; tenants read only their own entries; fail closed.
func TestAuditTrail(t *testing.T) {
	g := setup(t)
	tenantA, tenantB := g.tenant("Synthetic Tenant A"), g.tenant("Synthetic Tenant B")
	merA1 := g.merchant(tenantA, "TEST", "A One")
	g.merchant(tenantB, "TEST", "B One")
	g.grant(owner, tenantA, "", "MOWN")
	g.grant(dev, tenantA, "", "MDEV")
	g.grant(viewerB, tenantB, "", "MVIEW")
	path := func(id string) string { return "/v1/merchants/" + id }
	unknown := ids.NewPublic(ids.Merchant)
	attacker, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	type call struct {
		name  string
		token string
		path  string
		edit  func(*http.Request)
	}
	ownerTok, devTok, viewerTok := g.token(owner), g.token(dev), g.token(viewerB)
	forged := sign(t, attacker, map[string]any{"iss": issuer, "aud": audience, "sub": owner, "typ": "Bearer",
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix()})
	calls := []call{
		{"allowed", ownerTok, path(merA1), nil},
		{"forbidden", devTok, path(merA1), nil},
		{"other tenant", viewerTok, path(merA1), nil},
		{"does not exist", viewerTok, path(unknown), nil},
		{"no token", "", path(merA1), nil},
		{"forged token", forged, path(merA1), nil},
		{"forged headers", viewerTok, path(merA1), func(r *http.Request) {
			r.Header.Set("X-Tenant-Id", tenantA)
			r.Header.Set("X-User-Id", owner)
			r.URL.RawQuery = "tenant_id=" + tenantA
		}},
	}
	trace := map[string]string{}
	status := map[string]int{}
	for _, c := range calls {
		var edits []func(*http.Request)
		if c.edit != nil {
			edits = append(edits, c.edit)
		}
		rec := g.get(c.path, c.token, edits...)
		trace[c.name], status[c.name] = rec.Header().Get("X-Trace-Id"), rec.Code
	}
	all := g.entries(t)

	t.Run("rule 2: every request leaves one entry with who, what, when, tenant, outcome and trace ID", func(t *testing.T) {
		if len(all) != len(calls) {
			t.Fatalf("%d entries for %d requests", len(all), len(calls))
		}
		hash := audit.ResourceHash("merchant", merA1)
		for _, c := range []struct {
			name, subject, tenant, outcome, reason, action string
			status                                         int
		}{
			{"allowed", owner, tenantA, "ALLOWED", "", "getMerchant", 200},
			{"forbidden", dev, tenantA, "DENIED", "permission_denied", "getMerchant", 403},
			{"other tenant", viewerB, "", "DENIED", "resource_not_found", "getMerchant", 404},
			{"no token", "", "", "DENIED", "authentication_required", "authenticate", 401},
			{"forged token", "", "", "DENIED", "authentication_required", "authenticate", 401},
			{"forged headers", viewerB, "", "DENIED", "resource_not_found", "getMerchant", 404},
		} {
			e, ok := all[trace[c.name]]
			if !ok {
				t.Errorf("%s: no entry for trace %s", c.name, trace[c.name])
				continue
			}
			if status[c.name] != c.status || e.Status != c.status || e.Outcome != c.outcome || str(e.Reason) != c.reason || e.Action != c.action {
				t.Errorf("%s: entry %+v (response %d); want status %d, outcome %s, reason %q, action %s",
					c.name, e, status[c.name], c.status, c.outcome, c.reason, c.action)
			}
			if str(e.Subject) != c.subject || (c.subject != "" && str(e.Issuer) != issuer) || (c.subject == "" && e.Issuer != nil) {
				t.Errorf("%s: actor %s %s; want subject %q", c.name, str(e.Issuer), str(e.Subject), c.subject)
			}
			if str(e.Tenant) != c.tenant || e.Environment != "TEST" {
				t.Errorf("%s: tenant %q env %s; want tenant %q, TEST", c.name, str(e.Tenant), e.Environment, c.tenant)
			}
			if c.action == "getMerchant" && (str(e.ResourceType) != "merchant" || str(e.ResourceHash) != hash) {
				t.Errorf("%s: resource %s %s; want merchant and the hash of merchant A1", c.name, str(e.ResourceType), str(e.ResourceHash))
			}
			// timestamptz is an absolute instant; pgx shows it in the client's
			// zone, so compare the instant (the store's API returns UTC).
			if d := time.Since(e.At); d < 0 || d > time.Minute {
				t.Errorf("%s: occurred_at %s is not the time of the request", c.name, e.At.UTC())
			}
		}
	})

	t.Run("rule 3: a 404 for another tenant's merchant looks like one for a merchant that does not exist", func(t *testing.T) {
		a, b := all[trace["other tenant"]], all[trace["does not exist"]]
		a.TraceID, b.TraceID, a.ResourceHash, b.ResourceHash, a.At, b.At = "", "", nil, nil, time.Time{}, time.Time{}
		if str(a.Tenant) != "" || str(b.Tenant) != "" || a.Outcome != b.Outcome || a.Status != b.Status || str(a.Reason) != str(b.Reason) ||
			a.Action != b.Action || str(a.Subject) != str(b.Subject) || str(a.ResourceType) != str(b.ResourceType) {
			t.Errorf("entries differ beyond trace, time and requested-id hash:\n%+v\n%+v", a, b)
		}
	})

	t.Run("rule 4: no token or secret is stored", func(t *testing.T) {
		var dump string
		if err := g.su.QueryRow(t.Context(), `SELECT coalesce(string_agg(row_to_json(e)::text, E'\n'), '') FROM governance.audit_events e`).Scan(&dump); err != nil {
			t.Fatal(err)
		}
		for _, tok := range []string{ownerTok, devTok, viewerTok, forged} {
			for i, part := range strings.Split(tok, ".") {
				if len(part) > 8 && strings.Contains(dump, part) {
					t.Errorf("token part %d is stored in the audit log", i)
				}
			}
		}
		for _, s := range []string{"eyJ", "Bearer", "password", merA1, unknown} {
			if strings.Contains(dump, s) {
				t.Errorf("the audit log contains %q", s)
			}
		}
	})

	t.Run("rule 5: a tenant reads only its own entries", func(t *testing.T) {
		listA, err := g.audit.ListForTenant(t.Context(), "TEST", tenantA, 100)
		if err != nil {
			t.Fatal(err)
		}
		if len(listA) != 2 {
			t.Errorf("tenant A reads %d entries; want its 2 (allowed, forbidden)", len(listA))
		}
		for _, e := range listA {
			if e.TenantID != tenantA {
				t.Errorf("tenant A read an entry of %q", e.TenantID)
			}
		}
		listB, err := g.audit.ListForTenant(t.Context(), "TEST", tenantB, 100)
		if err != nil {
			t.Fatal(err)
		}
		if len(listB) != 0 {
			t.Errorf("tenant B reads %d entries; its user's 404 probes must not be attributed to any tenant", len(listB))
		}
	})

	t.Run("fail closed: if the audit log is unavailable, nothing is served", func(t *testing.T) {
		// Simulate an audit outage: zp_audit can no longer write. Restored afterwards.
		if _, err := g.su.Exec(t.Context(), `REVOKE INSERT ON governance.audit_events FROM zp_audit`); err != nil {
			t.Fatalf("simulate audit outage: %v", err)
		}
		t.Cleanup(func() {
			if _, err := g.su.Exec(context.Background(), `GRANT INSERT ON governance.audit_events TO zp_audit`); err != nil {
				t.Errorf("restore audit grant: %v", err)
			}
		})
		rec := g.get(path(merA1), g.token(owner))
		if rec.Code != http.StatusServiceUnavailable || strings.Contains(rec.Body.String(), "A One") || rec.Header().Get("ETag") != "" {
			t.Errorf("with the audit log unavailable: %d %s; want 503 without the merchant", rec.Code, rec.Body)
		}
		wantProblem(t, "audit unavailable", rec, http.StatusServiceUnavailable, "temporarily_unavailable")
	})
}
