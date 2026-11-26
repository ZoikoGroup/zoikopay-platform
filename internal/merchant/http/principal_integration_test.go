//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/ids"
)

type grantBody struct {
	TenantID      string `json:"tenant_id"`
	MerchantID    string `json:"merchant_id,omitempty"`
	Persona       string `json:"persona"`
	EffectiveFrom string `json:"effective_from"`
	ExpiresAt     string `json:"expires_at"`
}

type principalBody struct {
	Object      string      `json:"object"`
	Issuer      string      `json:"issuer"`
	Subject     string      `json:"subject"`
	Environment string      `json:"environment"`
	Grants      []grantBody `json:"grants"`
}

func wantPrincipal(t *testing.T, what string, rec *httptest.ResponseRecorder, sub string) principalBody {
	t.Helper()
	wantTrace(t, what, rec)
	if rec.Code != http.StatusOK {
		t.Fatalf("%s: status %d; want 200 (body %s)", what, rec.Code, rec.Body)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("%s: Cache-Control %q; want no-store", what, cc)
	}
	var p principalBody
	dec := json.NewDecoder(rec.Body)
	dec.DisallowUnknownFields() // additionalProperties: false
	if err := dec.Decode(&p); err != nil {
		t.Fatalf("%s: body does not match the Principal schema: %v", what, err)
	}
	if p.Object != "principal" || p.Issuer != issuer || p.Subject != sub || p.Environment != "test" || p.Grants == nil {
		t.Errorf("%s: principal %+v; want object principal, the caller's own issuer and subject, environment test, a list", what, p)
	}
	return p
}

// shape drops the times, which are checked separately.
func shape(gs []grantBody) []grantBody {
	out := []grantBody{}
	for _, g := range gs {
		out = append(out, grantBody{TenantID: g.TenantID, MerchantID: g.MerchantID, Persona: g.Persona})
	}
	return out
}

// TestGetPrincipal drives GET /v1/principal (OPEN_QUESTIONS Q39): the caller's
// own live grants, read from merchant.memberships on every request, which the
// admin console uses instead of its own role list.
func TestGetPrincipal(t *testing.T) {
	g := setup(t)
	tenantA, tenantB := g.tenant("Synthetic Tenant A"), g.tenant("Synthetic Tenant B")
	merA1 := g.merchant(tenantA, "TEST", "A One")
	merB1 := g.merchant(tenantB, "TEST", "B One")
	g.grant(owner, tenantA, "", "MOWN")
	g.grant(owner, tenantB, merB1, "MVIEW")
	opsGrant := g.grant(ops, tenantA, merA1, "MOPS")
	g.grant(viewerB, tenantB, "", "MVIEW")

	t.Run("no token: 401, no grants revealed", func(t *testing.T) {
		wantProblem(t, "no token", g.get("/v1/principal", ""), http.StatusUnauthorized, "authentication_required")
	})

	t.Run("valid token without a live grant: an empty list (deny by default)", func(t *testing.T) {
		p := wantPrincipal(t, "nobody", g.get("/v1/principal", g.token(nobody)), nobody)
		if len(p.Grants) != 0 {
			t.Errorf("grants %+v; want none", p.Grants)
		}
	})

	t.Run("only the caller's own grants, sorted, tenant-wide first, lower-case personas", func(t *testing.T) {
		p := wantPrincipal(t, "owner", g.get("/v1/principal", g.token(owner)), owner)
		want := []grantBody{{TenantID: tenantA, Persona: "mown"}, {TenantID: tenantB, MerchantID: merB1, Persona: "mview"}}
		if tenantB < tenantA {
			want[0], want[1] = want[1], want[0]
		}
		if got := shape(p.Grants); !reflect.DeepEqual(got, want) {
			t.Errorf("grants %+v; want %+v (never viewerB's or ops's)", got, want)
		}
		for _, gr := range p.Grants {
			from, err1 := time.Parse(time.RFC3339, gr.EffectiveFrom)
			until, err2 := time.Parse(time.RFC3339, gr.ExpiresAt)
			if err1 != nil || err2 != nil || !until.After(from) || !until.After(time.Now()) {
				t.Errorf("grant %+v: validity window not a live RFC 3339 window", gr)
			}
		}
	})

	t.Run("token claims, forged headers and query values grant nothing", func(t *testing.T) {
		tok := g.token(nobody, func(c map[string]any) {
			c["realm_access"] = map[string]any{"roles": []string{"MOWN", "SUPER_ADMIN"}}
			c["tenant_id"], c["persona"] = tenantA, "MOWN"
		})
		rec := g.get("/v1/principal?subject="+owner+"&tenant_id="+tenantA, tok, func(r *http.Request) {
			r.Header.Set("X-Tenant-Id", tenantA)
			r.Header.Set("X-Zp-Persona", "MOWN")
			r.Header.Set("X-Zp-Subject", owner)
		})
		if p := wantPrincipal(t, "forged", rec, nobody); len(p.Grants) != 0 {
			t.Errorf("grants %+v; want none: authority comes only from memberships", p.Grants)
		}
	})

	t.Run("a grant in another environment is not listed (environment from configuration)", func(t *testing.T) {
		liveOnly := "00000000-0000-4000-8000-0000000000c1"
		merLive := g.merchant(tenantA, "LIVE", "A Live")
		at := time.Now().UTC().Add(-time.Hour)
		g.inTenant(tenantA, `INSERT INTO merchant.memberships (id, issuer, subject, tenant_id, merchant_id, environment, persona,
			granted_by_issuer, granted_by_subject, approved_by_issuer, approved_by_subject, granted_at_utc, effective_from_utc, expires_at_utc)
			VALUES ($1::uuid, $2, $3, $4, $5, 'LIVE', 'MOPS', $2, $6, $2, $7, $8, $8, $9)`,
			ids.NewInternal(), issuer, liveOnly, tenantA, merLive, makerID, checkID, at, at.Add(48*time.Hour))
		if p := wantPrincipal(t, "live only", g.get("/v1/principal", g.token(liveOnly)), liveOnly); len(p.Grants) != 0 {
			t.Errorf("TEST gateway listed LIVE grants %+v", p.Grants)
		}
	})

	t.Run("a revoked grant is gone on the next request (no cache)", func(t *testing.T) {
		tok := g.token(ops)
		if p := wantPrincipal(t, "before", g.get("/v1/principal", tok), ops); len(p.Grants) != 1 || p.Grants[0].Persona != "mops" {
			t.Fatalf("before revocation: grants %+v; want the MOPS grant", p.Grants)
		}
		g.inTenant(tenantA, `UPDATE merchant.memberships SET revoked_at_utc = now(), revoked_by_issuer = $2, revoked_by_subject = $3 WHERE id = $1::uuid`,
			opsGrant, issuer, checkID)
		if p := wantPrincipal(t, "after", g.get("/v1/principal", tok), ops); len(p.Grants) != 0 {
			t.Errorf("after revocation, same token: grants %+v; want none", p.Grants)
		}
	})

	t.Run("every call is audited as getPrincipal", func(t *testing.T) {
		rec := g.get("/v1/principal", g.token(owner))
		id := wantTrace(t, "audited", rec)
		e, ok := g.entries(t)[id]
		if !ok || e.Action != "getPrincipal" || e.Outcome != "ALLOWED" || e.Status != http.StatusOK || str(e.Subject) != owner || e.Tenant != nil {
			t.Errorf("audit entry %+v (found %v); want getPrincipal ALLOWED 200 by owner, no single tenant", e, ok)
		}
	})
}
