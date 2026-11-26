//go:build integration

package store_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"github.com/zoiko/zoikopay/internal/merchant/store"
	"github.com/zoiko/zoikopay/internal/platform/authn"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/db"
)

// grantKey summarizes a grant for set comparison.
type grantKey struct {
	tenant, merchant, environment string
	persona                       authz.Persona
}

func keysOf(gs []authz.Grant) []grantKey {
	var out []grantKey
	for _, g := range gs {
		out = append(out, grantKey{g.TenantID, g.MerchantID, g.Environment, g.Persona})
	}
	slices.SortFunc(out, func(a, b grantKey) int {
		return strings.Compare(a.tenant+a.merchant+string(a.persona), b.tenant+b.merchant+string(b.persona))
	})
	return out
}

// TestGrantSource reads grants exactly as the resolver will: by the verified
// (issuer, subject), inside a subject transaction, so row-level security and
// the query both limit the rows to the caller's own live grants.
func TestGrantSource(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	src := store.NewGrantSource(f.gw)

	tenantA := f.newTenant(t, "Synthetic Tenant A")
	tenantB := f.newTenant(t, "Synthetic Tenant B")
	merA1 := f.newMerchant(t, tenantA, "A One")
	merB1 := f.newMerchant(t, tenantB, "B One")
	now := time.Now().UTC()

	f.mustGrant(t, grant{member: alice, tenant: tenantA, persona: "MOWN"})
	f.mustGrant(t, grant{member: alice, tenant: tenantB, merchant: merB1, persona: "MVIEW"})
	revoked := f.mustGrant(t, grant{member: alice, tenant: tenantA, persona: "MFIN"})
	if _, err := f.exec(f.prov, tenantA, revokeMembership, revoked, grantTime.Add(time.Minute), checker.Issuer, checker.Subject); err != nil {
		t.Fatal(err)
	}
	f.mustGrant(t, grant{member: alice, tenant: tenantA, persona: "MDEV", expiresAt: grantTime.Add(30 * time.Minute)}) // expired 30m ago
	f.mustGrant(t, grant{member: alice, tenant: tenantA, merchant: merA1, persona: "MOPS",
		effectiveFrom: now.Add(time.Hour), expiresAt: now.Add(2 * time.Hour)}) // not yet effective
	f.mustGrant(t, grant{member: bob, tenant: tenantA, persona: "MOWN"})
	f.mustGrant(t, grant{member: twin, tenant: tenantB, persona: "MOWN"})

	t.Run("returns exactly the subject's live grants, across tenants", func(t *testing.T) {
		gs, err := src.GrantsForSubject(ctx, alice)
		if err != nil {
			t.Fatal(err)
		}
		want := []grantKey{{tenantA, "", "TEST", authz.MOWN}, {tenantB, merB1, "TEST", authz.MVIEW}}
		if got := keysOf(gs); !slices.Equal(got, want) {
			t.Errorf("grants = %+v; want %+v", got, want)
		}
		for _, g := range gs {
			if g.Subject != alice || g.ID == "" || !g.EffectiveFrom.Before(now) || !g.ExpiresAt.After(now) {
				t.Errorf("grant %+v: wrong subject, missing ID or not live", g)
			}
		}
	})

	t.Run("row-level security alone hides revoked, expired and future grants", func(t *testing.T) {
		// No WHERE clause: only the own_active_memberships policy filters.
		if n := f.countAs(t, f.gw, asSubject(alice), `SELECT count(*) FROM merchant.memberships`); n != 2 {
			t.Errorf("alice sees %d memberships through the policy; want her 2 live ones", n)
		}
	})

	t.Run("the same subject from another issuer is another person", func(t *testing.T) {
		gs, err := src.GrantsForSubject(ctx, twin)
		if err != nil {
			t.Fatal(err)
		}
		if got, want := keysOf(gs), []grantKey{{tenantB, "", "TEST", authz.MOWN}}; !slices.Equal(got, want) {
			t.Errorf("twin's grants = %+v; want %+v", got, want)
		}
	})

	t.Run("an unknown subject gets nothing", func(t *testing.T) {
		gs, err := src.GrantsForSubject(ctx, nobody)
		if err != nil || len(gs) != 0 {
			t.Errorf("unknown subject: %d grants, %v; want none", len(gs), err)
		}
	})

	t.Run("an incomplete subject is refused before any query", func(t *testing.T) {
		if _, err := src.GrantsForSubject(ctx, db.Subject{Issuer: keycloak}); !errors.Is(err, db.ErrNoSubject) {
			t.Errorf("err = %v; want db.ErrNoSubject", err)
		}
	})

	t.Run("every grant has a required, ordered validity window", func(t *testing.T) {
		_, err := f.exec(f.prov, tenantA, `INSERT INTO merchant.memberships
			(id, issuer, subject, tenant_id, environment, persona, granted_by_issuer, granted_by_subject,
			 approved_by_issuer, approved_by_subject, granted_at_utc)
			VALUES (uuidv7(), $1, $2, $3, 'TEST', 'MVIEW', $4, $5, $6, $7, now())`,
			bob.Issuer, bob.Subject, tenantA, maker.Issuer, maker.Subject, checker.Issuer, checker.Subject)
		wantState(t, "grant without effective_from and expires_at", err, "23502")
		_, err = f.insertGrant(asTenant(tenantA), grant{member: bob, tenant: tenantA, persona: "MVIEW",
			effectiveFrom: grantTime.Add(time.Hour), expiresAt: grantTime.Add(time.Hour)})
		wantState(t, "expires_at equal to effective_from", err, checkViolation)
		_, err = f.insertGrant(asTenant(tenantA), grant{member: bob, tenant: tenantA, persona: "MVIEW",
			effectiveFrom: grantTime.Add(-time.Minute)})
		wantState(t, "effective before it was granted", err, checkViolation)
	})
}

// TestTokenToPrincipal runs the whole read path: a signed access token that
// also carries forged tenant and role claims, sent with forged tenant and role
// headers, is verified and resolved. Only merchant.memberships decides.
func TestTokenToPrincipal(t *testing.T) {
	f := setup(t)
	ctx := context.Background()

	tenantA := f.newTenant(t, "Synthetic Tenant A")
	tenantB := f.newTenant(t, "Synthetic Tenant B")
	tenantC := f.newTenant(t, "Synthetic Tenant C") // alice has nothing here
	merA1 := f.newMerchant(t, tenantA, "A One")
	merB1 := f.newMerchant(t, tenantB, "B One")
	merB2 := f.newMerchant(t, tenantB, "B Two")
	merC1 := f.newMerchant(t, tenantC, "C One")
	ownerA := f.mustGrant(t, grant{member: alice, tenant: tenantA, persona: "MOWN"})
	f.mustGrant(t, grant{member: alice, tenant: tenantB, merchant: merB1, persona: "MVIEW"})

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: key.Public(), KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	}))
	defer jwks.Close()
	verifier, err := authn.NewVerifier(authn.Config{
		Issuer: keycloak, Audience: "zoikopay-gateway", JWKSURL: jwks.URL,
		RequiredClaims: map[string]string{"typ": "Bearer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	resolver, err := authz.NewResolver(store.NewGrantSource(f.gw), "TEST", nil)
	if err != nil {
		t.Fatal(err)
	}

	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	token, err := jwt.Signed(signer).Claims(map[string]any{
		"iss": keycloak, "aud": "zoikopay-gateway", "sub": alice.Subject, "typ": "Bearer",
		"iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix(),
		// Forged authority: none of this may count.
		"tenant_id": tenantC, "merchant_id": merC1, "roles": []string{"SUPER_ADMIN", "MOWN"},
		"user_metadata": map[string]any{"tenant_id": tenantC, "persona": "MOWN"},
		"app_metadata":  map[string]any{"tenant_id": tenantC, "merchant_id": merC1},
	}).Serialize()
	if err != nil {
		t.Fatal(err)
	}

	principalFor := func() (authz.Principal, error) {
		req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/v1/merchants/"+merC1+"?tenant_id="+tenantC, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Tenant-ID", tenantC)
		req.Header.Set("X-Merchant-ID", merC1)
		req.Header.Set("X-Role", "MOWN")
		raw, err := authn.BearerToken(req)
		if err != nil {
			return authz.Principal{}, err
		}
		id, err := verifier.Verify(ctx, raw)
		if err != nil {
			return authz.Principal{}, err
		}
		return resolver.Resolve(ctx, id)
	}

	t.Run("only memberships decide; forged claims and headers grant nothing", func(t *testing.T) {
		p, err := principalFor()
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(p.Tenants(), slices.Sorted(slices.Values([]string{tenantA, tenantB}))) {
			t.Errorf("tenants = %v; want only A and B from memberships", p.Tenants())
		}
		for _, c := range []struct {
			persona          authz.Persona
			tenant, merchant string
			want             bool
		}{
			{authz.MOWN, tenantA, merA1, true},
			{authz.MVIEW, tenantB, merB1, true},
			{authz.MVIEW, tenantB, merB2, false}, // AT-007
			{authz.MOWN, tenantC, merC1, false},  // forged in token and headers
			{authz.MOWN, tenantC, "", false},
			{authz.MOWN, tenantB, merB1, false},
		} {
			if got := p.Holds(c.persona, c.tenant, c.merchant); got != c.want {
				t.Errorf("Holds(%s, %s, %s) = %v; want %v", c.persona, c.tenant, c.merchant, got, c.want)
			}
		}
	})

	t.Run("revoking a grant takes effect while the token is still valid", func(t *testing.T) {
		if _, err := f.exec(f.prov, tenantA, revokeMembership, ownerA, time.Now().UTC(), checker.Issuer, checker.Subject); err != nil {
			t.Fatal(err)
		}
		p, err := principalFor()
		if err != nil {
			t.Fatal(err)
		}
		if p.Holds(authz.MOWN, tenantA, merA1) || slices.Contains(p.Tenants(), tenantA) {
			t.Errorf("revoked grant still applies (02-02 AT-005): tenants %v", p.Tenants())
		}
	})

	t.Run("a principal with grants in TEST and LIVE is refused", func(t *testing.T) {
		merBLive := f.newMerchantIn(t, tenantB, "LIVE", "B Live")
		f.mustGrant(t, grant{member: alice, tenant: tenantB, merchant: merBLive, environment: "LIVE", persona: "MVIEW"})
		p, err := principalFor()
		if !errors.Is(err, authz.ErrAmbiguousPrincipal) {
			t.Fatalf("err = %v; want ErrAmbiguousPrincipal (02-02 §2.4)", err)
		}
		if p.HasAccess() {
			t.Error("an ambiguous principal must have no access")
		}
	})
}
