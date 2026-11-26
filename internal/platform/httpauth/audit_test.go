package httpauth_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"log/slog"
	"net/http"
	"sync"
	"testing"

	"github.com/zoiko/zoikopay/internal/platform/audit"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/httpauth"
	"github.com/zoiko/zoikopay/internal/platform/trace"
)

type entries struct {
	mu   sync.Mutex
	list []audit.Entry
}

func (e *entries) Record(_ context.Context, x audit.Entry) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.list = append(e.list, x)
	return nil
}

// audited wraps the env's gateway with the audit middleware, as Mount does.
func (e *env) audited(t *testing.T, rec audit.Recorder) {
	t.Helper()
	log := slog.New(slog.DiscardHandler)
	v, r := e.parts()
	e.handler = trace.Middleware(log, audit.Middleware(rec, "TEST", log)(httpauth.Authenticate(v, r, log)(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))))
}

// Only a verified identity becomes the actor (Q38 38.9); a rejected
// token's claims, forged headers and query values never do.
func TestAuditActorIsOnlyTheVerifiedIdentity(t *testing.T) {
	e := newEnv(t)
	e.grants.byWho[db.Subject{Issuer: issuer, Subject: alice}] = []authz.Grant{grant(alice, tenantA, "TEST", authz.MOWN)}
	rec := &entries{}
	e.audited(t, rec)
	attacker, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	superAdmin := "00000000-0000-4000-8000-000000000001"
	forged := signWith(t, attacker, "k1", map[string]any{"iss": issuer, "aud": audience, "sub": superAdmin, "typ": "Bearer",
		"iat": e.claims()["iat"], "exp": e.claims()["exp"]})

	e.do("")                                         // 401, no token
	e.do(forged)                                     // 401, forged token naming super.admin
	e.do(e.sign(e.claims()), func(r *http.Request) { // 204, valid, with forged headers
		r.Header.Set("X-User-Id", superAdmin)
		r.Header.Set("X-Tenant-Id", tenantB)
		r.URL.RawQuery = "sub=" + superAdmin
	})

	if len(rec.list) != 3 {
		t.Fatalf("%d entries; want 3", len(rec.list))
	}
	for i, want := range []struct {
		actor  *audit.Actor
		status int
		reason string
	}{
		{nil, 401, "authentication_required"},
		{nil, 401, "authentication_required"},
		{&audit.Actor{Issuer: issuer, Subject: alice}, 204, ""},
	} {
		got := rec.list[i]
		if (got.Actor == nil) != (want.actor == nil) || (got.Actor != nil && *got.Actor != *want.actor) {
			t.Errorf("entry %d: actor %+v; want %+v", i, got.Actor, want.actor)
		}
		if got.HTTPStatus != want.status || got.Reason != want.reason || got.TenantID != "" {
			t.Errorf("entry %d: %+v; want status %d, reason %q, no tenant", i, got, want.status, want.reason)
		}
	}
	if rec.list[0].Action != "authenticate" || rec.list[1].Action != "authenticate" {
		t.Errorf("authentication failures recorded as %q and %q; want action authenticate", rec.list[0].Action, rec.list[1].Action)
	}
}
