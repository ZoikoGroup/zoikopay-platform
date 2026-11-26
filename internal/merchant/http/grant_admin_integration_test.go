//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/ids"
)

// Grant administration through the gateway (OPEN_QUESTIONS Q40): invite,
// accept, request, approve, reject, list and revoke, over the real stack
// (token verification, principal resolution, tenant transactions, the
// database's own delegation rules, audit). Synthetic people only.

var keySeq int

// newKey returns a fresh Idempotency-Key (a UUID, 04-08).
func newKey() string {
	keySeq++
	return fmt.Sprintf(`"00000000-0000-4000-8000-%012d"`, keySeq)
}

func (g *gateway) do(method, path, token string, body any, headers map[string]string) *httptest.ResponseRecorder {
	g.t.Helper()
	var r *http.Request
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			g.t.Fatal(err)
		}
		r = httptest.NewRequestWithContext(g.t.Context(), method, path, bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequestWithContext(g.t.Context(), method, path, nil)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	g.handler.ServeHTTP(rec, r)
	return rec
}

// post sends a POST with a fresh Idempotency-Key unless headers name one.
func (g *gateway) post(path, token string, body any, headers ...map[string]string) *httptest.ResponseRecorder {
	h := map[string]string{"Idempotency-Key": newKey()}
	for _, m := range headers {
		for k, v := range m {
			h[k] = v
		}
	}
	return g.do(http.MethodPost, path, token, body, h)
}

func decode(t *testing.T, what string, rec *httptest.ResponseRecorder, status int) map[string]any {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("%s: status %d, want %d (body %s)", what, rec.Code, status, rec.Body)
	}
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("%s: body is not JSON: %v", what, err)
	}
	return m
}

type grantPeople struct {
	g                                   *gateway
	tenantA, tenantB, merA1, merA2      string
	ownerA, ownerB, ownerM1, opsA, ownB string // Keycloak-style subjects
}

const (
	subOwnerA   = "00000000-0000-4000-8000-0000000000e1"
	subOwnerB   = "00000000-0000-4000-8000-0000000000e2"
	subOwnerM1  = "00000000-0000-4000-8000-0000000000e3"
	subOpsA     = "00000000-0000-4000-8000-0000000000e4"
	subOwnerOfB = "00000000-0000-4000-8000-0000000000e5"
	subInvitee  = "00000000-0000-4000-8000-0000000000e6"
	subInvitee2 = "00000000-0000-4000-8000-0000000000e7"
)

func grantSetup(t *testing.T, opts ...func(*options)) *grantPeople {
	g := setup(t, opts...)

	o := options{environment: "TEST"}
	for _, f := range opts {
		f(&o)
	}
	env := o.environment
	p := &grantPeople{g: g}
	p.tenantA, p.tenantB = g.tenant("Synthetic Tenant A"), g.tenant("Synthetic Tenant B")
	p.merA1, p.merA2 = g.merchant(p.tenantA, env, "A One"), g.merchant(p.tenantA, env, "A Two")
	g.merchant(p.tenantB, env, "B One")
	month := 30 * 24 * time.Hour
	g.grantFor(subOwnerA, p.tenantA, "", env, "MOWN", month)
	g.grantFor(subOwnerB, p.tenantA, "", env, "MOWN", month)
	g.grantFor(subOwnerM1, p.tenantA, p.merA1, env, "MOWN", month)
	g.grantFor(subOpsA, p.tenantA, p.merA1, env, "MOPS", month)
	g.grantFor(subOwnerOfB, p.tenantB, "", env, "MOWN", month)
	p.ownerA, p.ownerB, p.ownerM1, p.opsA, p.ownB = g.token(subOwnerA), g.token(subOwnerB), g.token(subOwnerM1), g.token(subOpsA), g.token(subOwnerOfB)
	return p
}

func (p *grantPeople) path(tenant, rest string) string { return "/v1/tenants/" + tenant + rest }

// invite returns an accepted invitation's ID for sub.
func (p *grantPeople) inviteAccepted(t *testing.T, sub string) string {
	t.Helper()
	inv := decode(t, "invite", p.g.post(p.path(p.tenantA, "/invitations"), p.ownerA, nil), http.StatusCreated)
	decode(t, "accept", p.g.post("/v1/invitations/accept", p.g.token(sub), map[string]any{"token": inv["token"]}), http.StatusOK)
	return inv["id"].(string)
}

func (p *grantPeople) requestBody(invitation, merchant, persona string, lasts time.Duration) map[string]any {
	b := map[string]any{"invitation_id": invitation, "persona": persona,
		"effective_from": time.Now().UTC().Format(time.RFC3339), "expires_at": time.Now().UTC().Add(lasts).Format(time.RFC3339),
		"purpose": "joining the payments team"}
	if merchant != "" {
		b["merchant_id"] = merchant
	}
	return b
}

func ifMatch(etag string) map[string]string { return map[string]string{"If-Match": etag} }

func TestGrantAdministrationFlow(t *testing.T) {
	p := grantSetup(t)
	g := p.g
	invitee := g.token(subInvitee)

	// Invite.
	key := newKey()
	created := g.post(p.path(p.tenantA, "/invitations"), p.ownerA, nil, map[string]string{"Idempotency-Key": key})
	inv := decode(t, "create invitation", created, http.StatusCreated)
	token, _ := inv["token"].(string)
	if !strings.HasPrefix(token, "zpinv_") || inv["status"] != "pending" || !strings.HasPrefix(inv["id"].(string), "inv_") {
		t.Fatalf("invitation %v: want a pending inv_ with a zpinv_ token", inv)
	}
	replay := decode(t, "replay", g.post(p.path(p.tenantA, "/invitations"), p.ownerA, nil, map[string]string{"Idempotency-Key": key}), http.StatusOK)
	if replay["id"] != inv["id"] || replay["token"] != nil {
		t.Errorf("replay %v: want the same invitation without its token", replay)
	}

	// Accept: grants nothing yet.
	acc := decode(t, "accept", g.post("/v1/invitations/accept", invitee, map[string]any{"token": token}), http.StatusOK)
	if acc["status"] != "accepted" || acc["accepted_by"].(map[string]any)["subject"] != subInvitee {
		t.Errorf("accepted invitation %v", acc)
	}
	if pr := decode(t, "principal after accepting", g.get("/v1/principal", invitee), http.StatusOK); len(pr["grants"].([]any)) != 0 {
		t.Errorf("accepting an invitation granted %v", pr["grants"])
	}

	// Request (maker: ownerA).
	req := g.post(p.path(p.tenantA, "/access_requests"), p.ownerA, p.requestBody(inv["id"].(string), p.merA1, "mview", 7*24*time.Hour))
	ar := decode(t, "request", req, http.StatusCreated)
	if ar["status"] != "awaiting_independent_approval" || req.Header().Get("ETag") != `"access-request-v1"` {
		t.Fatalf("request %v (ETag %q)", ar, req.Header().Get("ETag"))
	}
	reqPath := p.path(p.tenantA, "/access_requests/"+ar["id"].(string))
	if rec := g.get("/v1/merchants/"+p.merA1, invitee); rec.Code != http.StatusNotFound {
		t.Errorf("before approval the invitee reads the merchant: %d", rec.Code)
	}

	// Approve (checker: ownerB).
	approved := decode(t, "approve", g.post(reqPath+"/approval", p.ownerB, nil, ifMatch(`"access-request-v1"`)), http.StatusOK)
	mbr, _ := approved["membership_id"].(string)
	if approved["status"] != "approved" || !strings.HasPrefix(mbr, "mbr_") || approved["decided_by"].(map[string]any)["subject"] != subOwnerB {
		t.Fatalf("approved request %v", approved)
	}

	// Access works.
	wantMerchant(t, "invitee after approval", g.get("/v1/merchants/"+p.merA1, invitee), p.merA1, "A One")
	list := decode(t, "list memberships", g.get(p.path(p.tenantA, "/memberships"), p.ownerA), http.StatusOK)
	found := false
	for _, m := range list["data"].([]any) {
		if m.(map[string]any)["id"] == mbr {
			found = true
		}
	}
	if !found {
		t.Errorf("the new grant is not in the tenant's memberships")
	}

	// Revoke: denied on the next request, same token.
	revoked := decode(t, "revoke", g.post(p.path(p.tenantA, "/memberships/"+mbr+"/revocation"), p.ownerA, map[string]any{"reason": "left the team"}), http.StatusOK)
	if revoked["revoked_by"].(map[string]any)["subject"] != subOwnerA || revoked["revoked_at"] == nil {
		t.Errorf("revoked grant %v", revoked)
	}
	if rec := g.get("/v1/merchants/"+p.merA1, invitee); rec.Code != http.StatusNotFound {
		t.Errorf("after revocation, same token: %d, want 404", rec.Code)
	}
	if pr := decode(t, "principal after revocation", g.get("/v1/principal", invitee), http.StatusOK); len(pr["grants"].([]any)) != 0 {
		t.Errorf("after revocation the invitee still holds %v", pr["grants"])
	}

	t.Run("every step left a grant event and an audit entry, and no token anywhere", func(t *testing.T) {
		var types []string
		rows, err := g.su.Query(t.Context(), `SELECT event_type FROM merchant.grant_events
			WHERE invitation_id = $1 OR access_request_id = $2 OR membership_id = $3 ORDER BY occurred_at_utc`, inv["id"], ar["id"], mbr)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var s string
			_ = rows.Scan(&s)
			types = append(types, s)
		}
		rows.Close()
		want := "INVITATION_CREATED,INVITATION_ACCEPTED,ACCESS_REQUESTED,ACCESS_APPROVED,GRANT_CREATED,GRANT_REVOKED"
		if got := strings.Join(types, ","); got != want {
			t.Errorf("grant events %s; want %s", got, want)
		}
		actions := map[string]bool{}
		for _, e := range g.entries(t) {
			actions[e.Action] = true
		}
		for _, a := range []string{"createInvitation", "acceptInvitation", "createAccessRequest", "approveAccessRequest", "listMemberships", "revokeMembership"} {
			if !actions[a] {
				t.Errorf("no audit entry for %s", a)
			}
		}
		var stored int
		if err := g.su.QueryRow(t.Context(), `SELECT count(*) FROM merchant.invitations WHERE encode(token_hash, 'escape') LIKE '%zpinv_%'`).Scan(&stored); err != nil || stored != 0 {
			t.Errorf("an invitation token is stored in clear (%d, %v)", stored, err)
		}
		if strings.Contains(g.logs.String(), token) {
			t.Error("the invitation token is in the gateway log")
		}
		var inAudit int
		if err := g.su.QueryRow(t.Context(), `SELECT count(*) FROM governance.audit_events a WHERE row_to_json(a)::text LIKE '%' || $1 || '%'`, token).Scan(&inAudit); err != nil || inAudit != 0 {
			t.Errorf("the invitation token is in the audit log (%d, %v)", inAudit, err)
		}
	})
}

func TestGrantAdministrationRules(t *testing.T) {
	p := grantSetup(t)
	g := p.g
	invA := p.inviteAccepted(t, subInvitee)
	week := 7 * 24 * time.Hour
	request := func(token string, body map[string]any) *httptest.ResponseRecorder {
		return g.post(p.path(p.tenantA, "/access_requests"), token, body)
	}
	expect := func(t *testing.T, what string, rec *httptest.ResponseRecorder, status int, code string) {
		t.Helper()
		wantProblem(t, what, rec, status, code)
	}

	t.Run("maker, checker and member are three different people", func(t *testing.T) {
		ar := decode(t, "request", request(p.ownerA, p.requestBody(invA, p.merA1, "mops", week)), http.StatusCreated)
		path := p.path(p.tenantA, "/access_requests/"+ar["id"].(string))
		expect(t, "the maker approves", g.post(path+"/approval", p.ownerA, nil, ifMatch(`"access-request-v1"`)), http.StatusConflict, "sod_conflict")
		expect(t, "the member approves", g.post(path+"/approval", g.token(subInvitee), nil, ifMatch(`"access-request-v1"`)), http.StatusNotFound, "resource_not_found")

		// ownerB asks to be given a role: ownerB cannot approve it.
		ownMbr := decode(t, "list", g.get(p.path(p.tenantA, "/memberships"), p.ownerA), http.StatusOK)
		var ownerBGrant string
		for _, m := range ownMbr["data"].([]any) {
			if mm := m.(map[string]any); mm["member"].(map[string]any)["subject"] == subOwnerB {
				ownerBGrant = mm["id"].(string)
			}
		}
		body := p.requestBody("", p.merA2, "mview", week)
		delete(body, "invitation_id")
		body["membership_id"] = ownerBGrant
		self := decode(t, "request for ownerB", request(p.ownerA, body), http.StatusCreated)
		expect(t, "the member approves their own role", g.post(p.path(p.tenantA, "/access_requests/"+self["id"].(string)+"/approval"), p.ownerB, nil,
			ifMatch(`"access-request-v1"`)), http.StatusConflict, "sod_conflict")
		expect(t, "the maker asks for themselves", request(p.ownerB, body), http.StatusConflict, "sod_conflict")

		inv := decode(t, "invite", g.post(p.path(p.tenantA, "/invitations"), p.ownerA, nil), http.StatusCreated)
		expect(t, "the inviter accepts their own invitation", g.post("/v1/invitations/accept", p.ownerA, map[string]any{"token": inv["token"]}),
			http.StatusConflict, "sod_conflict")
	})

	t.Run("never grant above the delegator", func(t *testing.T) {
		expect(t, "merchant owner asks tenant-wide", request(p.ownerM1, p.requestBody(invA, "", "mview", week)), http.StatusForbidden, "delegation_exceeded")
		expect(t, "merchant owner asks for a sibling", request(p.ownerM1, p.requestBody(invA, p.merA2, "mview", week)), http.StatusForbidden, "delegation_exceeded")
		expect(t, "longer than the maker's own owner role", request(p.ownerA, p.requestBody(invA, p.merA1, "mview", 60*24*time.Hour)), http.StatusForbidden, "delegation_exceeded")
		expect(t, "an owner role", request(p.ownerA, p.requestBody(invA, p.merA1, "mown", week)), http.StatusForbidden, "permission_denied")
		decode(t, "merchant owner, own merchant", request(p.ownerM1, p.requestBody(invA, p.merA1, "mview", week)), http.StatusCreated)
		wide := decode(t, "tenant-wide by ownerA", request(p.ownerA, p.requestBody(invA, "", "mdev", week)), http.StatusCreated)
		expect(t, "merchant owner approves tenant-wide", g.post(p.path(p.tenantA, "/access_requests/"+wide["id"].(string)+"/approval"), p.ownerM1, nil,
			ifMatch(`"access-request-v1"`)), http.StatusForbidden, "delegation_exceeded")
	})

	t.Run("only owners administer, and only in their own tenant", func(t *testing.T) {
		expect(t, "MOPS invites", g.post(p.path(p.tenantA, "/invitations"), p.opsA, nil), http.StatusForbidden, "permission_denied")
		expect(t, "MOPS lists memberships", g.get(p.path(p.tenantA, "/memberships"), p.opsA), http.StatusForbidden, "permission_denied")
		expect(t, "MOPS requests", request(p.opsA, p.requestBody(invA, p.merA1, "mview", week)), http.StatusForbidden, "permission_denied")
		other := g.post(p.path(p.tenantA, "/invitations"), p.ownB, nil)
		ghost := g.post(p.path(ids.NewPublic(ids.Tenant), "/invitations"), p.ownB, nil)
		expect(t, "another tenant's owner", other, http.StatusNotFound, "resource_not_found")
		expect(t, "a tenant that does not exist", ghost, http.StatusNotFound, "resource_not_found")
		var a, b problem
		_ = json.Unmarshal(other.Body.Bytes(), &a)
		_ = json.Unmarshal(ghost.Body.Bytes(), &b)
		if a.Detail != b.Detail || a.Title != b.Title {
			t.Errorf("another tenant and no tenant answer differently: %+v vs %+v", a, b)
		}
		for _, path := range []string{"/memberships", "/access_requests", "/invitations"} {
			expect(t, "another tenant's "+path, g.get(p.path(p.tenantA, path), p.ownB), http.StatusNotFound, "resource_not_found")
		}
		wantProblem(t, "no token", g.post(p.path(p.tenantA, "/invitations"), "", nil), http.StatusUnauthorized, "authentication_required")
	})

	t.Run("invitations are single use and need a real token", func(t *testing.T) {
		inv := decode(t, "invite", g.post(p.path(p.tenantA, "/invitations"), p.ownerA, nil), http.StatusCreated)
		decode(t, "accept", g.post("/v1/invitations/accept", g.token(subInvitee2), map[string]any{"token": inv["token"]}), http.StatusOK)
		used := g.post("/v1/invitations/accept", g.token(subInvitee), map[string]any{"token": inv["token"]})
		unknown := g.post("/v1/invitations/accept", g.token(subInvitee), map[string]any{"token": "zpinv_" + strings.Repeat("A", 43)})
		malformed := g.post("/v1/invitations/accept", g.token(subInvitee), map[string]any{"token": "not-a-token"})
		for what, rec := range map[string]*httptest.ResponseRecorder{"a used token (replay)": used, "an unknown token": unknown, "a malformed token": malformed} {
			expect(t, what, rec, http.StatusNotFound, "resource_not_found")
		}
		expect(t, "a request for someone who never accepted", request(p.ownerA, p.requestBody(decode(t, "fresh invite",
			g.post(p.path(p.tenantA, "/invitations"), p.ownerA, nil), http.StatusCreated)["id"].(string), p.merA1, "mview", week)),
			http.StatusUnprocessableEntity, "validation_error")
	})

	t.Run("decisions need the current version, a key, and happen once", func(t *testing.T) {
		ar := decode(t, "request", request(p.ownerA, p.requestBody(invA, p.merA2, "mfin", week)), http.StatusCreated)
		path := p.path(p.tenantA, "/access_requests/"+ar["id"].(string))
		expect(t, "a stale If-Match", g.post(path+"/approval", p.ownerB, nil, ifMatch(`"access-request-v7"`)), http.StatusConflict, "version_conflict")
		expect(t, "no If-Match", g.post(path+"/approval", p.ownerB, nil), http.StatusPreconditionRequired, "precondition_required")
		expect(t, "no Idempotency-Key", g.do(http.MethodPost, path+"/approval", p.ownerB, nil, ifMatch(`"access-request-v1"`)), http.StatusBadRequest, "idempotency_key_required")
		key := map[string]string{"If-Match": `"access-request-v1"`, "Idempotency-Key": newKey()}
		first := decode(t, "approve", g.post(path+"/approval", p.ownerB, nil, key), http.StatusOK)
		again := decode(t, "replay the approval", g.post(path+"/approval", p.ownerB, nil, key), http.StatusOK)
		if again["membership_id"] != first["membership_id"] || again["status"] != "approved" {
			t.Errorf("replay %v differs from %v", again, first)
		}
		expect(t, "deciding again with a new key", g.post(path+"/rejection", p.ownerB, map[string]any{"reason": "late"}, ifMatch(`"access-request-v2"`)),
			http.StatusConflict, "operation_state_conflict")

		dup := decode(t, "the same role again", request(p.ownerA, p.requestBody(invA, p.merA2, "mfin", week)), http.StatusCreated)
		expect(t, "approving a role the member already holds", g.post(p.path(p.tenantA, "/access_requests/"+dup["id"].(string)+"/approval"), p.ownerB, nil,
			ifMatch(`"access-request-v1"`)), http.StatusConflict, "operation_state_conflict")

		rj := decode(t, "request to reject", request(p.ownerA, p.requestBody(invA, p.merA1, "mfin", week)), http.StatusCreated)
		rpath := p.path(p.tenantA, "/access_requests/"+rj["id"].(string))
		expect(t, "a rejection without a reason", g.post(rpath+"/rejection", p.ownerB, map[string]any{"reason": " "}, ifMatch(`"access-request-v1"`)),
			http.StatusUnprocessableEntity, "validation_error")
		rejected := decode(t, "reject", g.post(rpath+"/rejection", p.ownerB, map[string]any{"reason": "not needed"}, ifMatch(`"access-request-v1"`)), http.StatusOK)
		if rejected["status"] != "rejected" || rejected["decision_reason"] != "not needed" {
			t.Errorf("rejected request %v", rejected)
		}
		list := decode(t, "list rejected", g.get(p.path(p.tenantA, "/access_requests?status=rejected"), p.ownerA), http.StatusOK)
		for _, r := range list["data"].([]any) {
			if r.(map[string]any)["status"] != "rejected" {
				t.Errorf("status filter returned %v", r)
			}
		}
	})

	t.Run("owner grants are not revoked here, and revocation needs a covering owner", func(t *testing.T) {
		ms := decode(t, "list", g.get(p.path(p.tenantA, "/memberships"), p.ownerA), http.StatusOK)
		var ownerGrant, opsGrant string
		for _, m := range ms["data"].([]any) {
			mm := m.(map[string]any)
			switch mm["member"].(map[string]any)["subject"] {
			case subOwnerB:
				ownerGrant = mm["id"].(string)
			case subOpsA:
				opsGrant = mm["id"].(string)
			}
		}
		expect(t, "revoke an owner grant", g.post(p.path(p.tenantA, "/memberships/"+ownerGrant+"/revocation"), p.ownerA, map[string]any{"reason": "x"}),
			http.StatusForbidden, "permission_denied")
		expect(t, "MOPS revokes", g.post(p.path(p.tenantA, "/memberships/"+opsGrant+"/revocation"), p.opsA, map[string]any{"reason": "x"}),
			http.StatusForbidden, "permission_denied")
		expect(t, "an unknown grant", g.post(p.path(p.tenantA, "/memberships/"+ids.NewPublic(ids.Membership)+"/revocation"), p.ownerA, map[string]any{"reason": "x"}),
			http.StatusNotFound, "resource_not_found")
		decode(t, "the merchant owner revokes MOPS on their merchant", g.post(p.path(p.tenantA, "/memberships/"+opsGrant+"/revocation"), p.ownerM1,
			map[string]any{"reason": "left"}), http.StatusOK)
		expect(t, "revoke twice", g.post(p.path(p.tenantA, "/memberships/"+opsGrant+"/revocation"), p.ownerA, map[string]any{"reason": "again"}),
			http.StatusConflict, "operation_state_conflict")
	})
}

func TestGrantAdministrationExpiry(t *testing.T) {
	p := grantSetup(t, func(o *options) { o.invitationTTL, o.requestTTL = 2*time.Second, 2*time.Second })
	g := p.g
	invA := p.inviteAccepted(t, subInvitee)
	inv := decode(t, "invite", g.post(p.path(p.tenantA, "/invitations"), p.ownerA, nil), http.StatusCreated)
	ar := decode(t, "request", g.post(p.path(p.tenantA, "/access_requests"), p.ownerA, p.requestBody(invA, p.merA1, "mview", 24*time.Hour)), http.StatusCreated)
	time.Sleep(2300 * time.Millisecond)
	wantProblem(t, "accept an expired invitation", g.post("/v1/invitations/accept", g.token(subInvitee2), map[string]any{"token": inv["token"]}),
		http.StatusNotFound, "resource_not_found")
	wantProblem(t, "approve an expired request", g.post(p.path(p.tenantA, "/access_requests/"+ar["id"].(string)+"/approval"), p.ownerB, nil,
		ifMatch(`"access-request-v1"`)), http.StatusConflict, "operation_state_conflict")
	list := decode(t, "list", g.get(p.path(p.tenantA, "/access_requests?status=expired"), p.ownerA), http.StatusOK)
	if len(list["data"].([]any)) != 1 {
		t.Errorf("expired requests listed: %v", list["data"])
	}
	invs := decode(t, "list invitations", g.get(p.path(p.tenantA, "/invitations"), p.ownerA), http.StatusOK)
	for _, i := range invs["data"].([]any) {
		im := i.(map[string]any)
		if im["id"] == inv["id"] && im["status"] != "expired" {
			t.Errorf("expired invitation reported as %v", im["status"])
		}
		if im["token"] != nil {
			t.Error("a listed invitation carries its token")
		}
	}
}

func TestGrantAdministrationLiveNeedsStepUp(t *testing.T) {
	p := grantSetup(t, func(o *options) { o.environment = "LIVE" })
	g := p.g
	invA := p.inviteAccepted(t, subInvitee) // invitations grant nothing, so LIVE allows them
	ar := decode(t, "request", g.post(p.path(p.tenantA, "/access_requests"), p.ownerA, p.requestBody(invA, p.merA1, "mview", 24*time.Hour)), http.StatusCreated)
	wantProblem(t, "approve in LIVE", g.post(p.path(p.tenantA, "/access_requests/"+ar["id"].(string)+"/approval"), p.ownerB, nil,
		ifMatch(`"access-request-v1"`)), http.StatusForbidden, "step_up_required")
	ms := decode(t, "list", g.get(p.path(p.tenantA, "/memberships"), p.ownerA), http.StatusOK)
	var ops string
	for _, m := range ms["data"].([]any) {
		if mm := m.(map[string]any); mm["persona"] == "mops" {
			ops = mm["id"].(string)
		}
	}
	wantProblem(t, "revoke in LIVE", g.post(p.path(p.tenantA, "/memberships/"+ops+"/revocation"), p.ownerA, map[string]any{"reason": "x"}),
		http.StatusForbidden, "step_up_required")
}
