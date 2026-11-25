package authz_test

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/authn"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/db"
)

const (
	keycloak = "http://localhost:8180/realms/zoikopay"
	tenantA  = "ten_a"
	tenantB  = "ten_b"
	merA1    = "mer_a1"
	merA2    = "mer_a2"
	merB1    = "mer_b1"
	merB2    = "mer_b2"
)

var (
	now = time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	me  = authn.Identity{Issuer: keycloak, Subject: "00000000-0000-4000-8000-00000000a11c"}
)

// fakeSource stands in for BC-01's merchant.memberships.
type fakeSource struct {
	grants []authz.Grant
	err    error
	calls  int
	asked  db.Subject
}

func (f *fakeSource) GrantsForSubject(_ context.Context, s db.Subject) ([]authz.Grant, error) {
	f.calls++
	f.asked = s
	return slices.Clone(f.grants), f.err
}

// live returns a grant for me that is valid now.
func live(tenant, merchant string, p authz.Persona) authz.Grant {
	return authz.Grant{
		ID: "grant-" + tenant + "-" + merchant + "-" + string(p), Subject: db.Subject{Issuer: me.Issuer, Subject: me.Subject},
		TenantID: tenant, MerchantID: merchant, Environment: "TEST", Persona: p,
		EffectiveFrom: now.Add(-time.Hour), ExpiresAt: now.Add(24 * time.Hour),
	}
}

func resolver(t *testing.T, src authz.GrantSource) *authz.Resolver {
	t.Helper()
	r, err := authz.NewResolver(src, "TEST", func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func resolve(t *testing.T, grants ...authz.Grant) authz.Principal {
	t.Helper()
	p, err := resolver(t, &fakeSource{grants: grants}).Resolve(context.Background(), me)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	return p
}

var allPersonas = []authz.Persona{authz.MOWN, authz.MOPS, authz.MFIN, authz.MDEV, authz.MVIEW}

// assertNothing checks that p can do nothing anywhere.
func assertNothing(t *testing.T, what string, p authz.Principal) {
	t.Helper()
	if p.HasAccess() || len(p.Tenants()) != 0 || len(p.Grants()) != 0 {
		t.Errorf("%s: principal has access (tenants %v, grants %d); want none", what, p.Tenants(), len(p.Grants()))
	}
	for _, tenant := range []string{tenantA, tenantB, "", "*"} {
		for _, merchant := range []string{merA1, merB1, "", "*"} {
			for _, persona := range allPersonas {
				if p.Holds(persona, tenant, merchant) {
					t.Errorf("%s: Holds(%s, %q, %q) = true; want false", what, persona, tenant, merchant)
				}
			}
		}
	}
}

func TestDenyByDefault(t *testing.T) {
	assertNothing(t, "zero-value principal", authz.Principal{})
	assertNothing(t, "subject with no grants", resolve(t))
}

func TestResolvesRolesAndScopeFromGrants(t *testing.T) {
	p := resolve(t,
		live(tenantA, "", authz.MOWN),    // tenant-wide
		live(tenantB, merB1, authz.MOPS), // one merchant
	)
	if !p.HasAccess() || !slices.Equal(p.Tenants(), []string{tenantA, tenantB}) {
		t.Fatalf("tenants = %v; want [%s %s]", p.Tenants(), tenantA, tenantB)
	}
	if p.Identity.Issuer != me.Issuer || p.Identity.Subject != me.Subject || p.Environment != "TEST" {
		t.Errorf("principal identity %+v env %s; want %+v TEST", p.Identity, p.Environment, me)
	}
	for _, c := range []struct {
		persona          authz.Persona
		tenant, merchant string
		want             bool
	}{
		{authz.MOWN, tenantA, merA1, true}, // tenant-wide grant covers every merchant of A
		{authz.MOWN, tenantA, merA2, true},
		{authz.MOWN, tenantA, "", true}, // and tenant-level resources
		{authz.MOPS, tenantA, merA1, false},
		{authz.MOPS, tenantB, merB1, true},
		{authz.MOPS, tenantB, merB2, false}, // 02-02 AT-007: sibling merchant needs its own relation
		{authz.MOPS, tenantB, "", false},    // a merchant-scoped grant is not tenant-wide
		{authz.MOWN, tenantB, merB1, false},
		{authz.MOWN, "ten_other", merA1, false},
		{authz.MOWN, "*", "*", false}, // no wildcards
	} {
		if got := p.Holds(c.persona, c.tenant, c.merchant); got != c.want {
			t.Errorf("Holds(%s, %s, %q) = %v; want %v", c.persona, c.tenant, c.merchant, got, c.want)
		}
	}
	if got := p.Personas(tenantA, merA1); !slices.Equal(got, []authz.Persona{authz.MOWN}) {
		t.Errorf("Personas(A, merA1) = %v; want [MOWN]", got)
	}
	if got := p.Personas(tenantB, merB2); len(got) != 0 {
		t.Errorf("Personas(B, merB2) = %v; want none", got)
	}
}

func TestIgnoresGrantsThatAreNotLive(t *testing.T) {
	expired := live(tenantA, "", authz.MOWN)
	expired.ExpiresAt = now // expiry is exclusive
	future := live(tenantA, "", authz.MFIN)
	future.EffectiveFrom = now.Add(time.Second)
	staff := live(tenantA, "", authz.Persona("POR")) // 36.1: staff personas never come from memberships
	super := live(tenantA, "", authz.Persona("SUPER_ADMIN"))
	lower := live(tenantA, "", authz.Persona("mown"))
	noTenant := live("", "", authz.MOWN)
	badEnv := live(tenantA, "", authz.MVIEW)
	badEnv.Environment = "PROD"
	inverted := live(tenantA, "", authz.MDEV)
	inverted.EffectiveFrom, inverted.ExpiresAt = now.Add(time.Hour), now.Add(-time.Hour)

	assertNothing(t, "only grants that are not live", resolve(t, expired, future, staff, super, lower, noTenant, badEnv, inverted))

	p := resolve(t, expired, live(tenantA, merA1, authz.MVIEW))
	if p.Holds(authz.MOWN, tenantA, merA1) || !p.Holds(authz.MVIEW, tenantA, merA1) || len(p.Grants()) != 1 {
		t.Errorf("an expired grant must be dropped and the live one kept; grants = %+v", p.Grants())
	}
}

func TestOtherEnvironmentGivesNothing(t *testing.T) {
	g := live(tenantA, "", authz.MOWN)
	g.Environment = "LIVE"
	assertNothing(t, "LIVE grant on a TEST deployment", resolve(t, g)) // 02-02 AT-008
}

func TestPrincipalInBothEnvironmentsIsRefused(t *testing.T) {
	liveGrant := live(tenantB, "", authz.MVIEW)
	liveGrant.Environment = "LIVE"
	p, err := resolver(t, &fakeSource{grants: []authz.Grant{live(tenantA, "", authz.MOWN), liveGrant}}).Resolve(context.Background(), me)
	if !errors.Is(err, authz.ErrAmbiguousPrincipal) {
		t.Fatalf("err = %v; want ErrAmbiguousPrincipal (02-02 §2.4 distinct principals)", err)
	}
	assertNothing(t, "ambiguous principal", p)
}

func TestSourceFailureFailsClosed(t *testing.T) {
	src := &fakeSource{grants: []authz.Grant{live(tenantA, "", authz.MOWN)}, err: errors.New("database unreachable")}
	p, err := resolver(t, src).Resolve(context.Background(), me)
	if !errors.Is(err, authz.ErrGrantsUnavailable) {
		t.Fatalf("err = %v; want ErrGrantsUnavailable", err)
	}
	assertNothing(t, "source failure", p)
}

func TestGrantForAnotherSubjectFailsClosed(t *testing.T) {
	for name, s := range map[string]db.Subject{
		"another subject":                  {Issuer: me.Issuer, Subject: "someone-else"},
		"same subject from another issuer": {Issuer: "https://other-issuer.example.test", Subject: me.Subject},
	} {
		g := live(tenantA, "", authz.MOWN)
		g.Subject = s
		p, err := resolver(t, &fakeSource{grants: []authz.Grant{live(tenantB, "", authz.MVIEW), g}}).Resolve(context.Background(), me)
		if !errors.Is(err, authz.ErrGrantsUnavailable) {
			t.Errorf("%s: err = %v; want ErrGrantsUnavailable", name, err)
		}
		assertNothing(t, name, p)
	}
}

func TestIncompleteIdentityIsRefused(t *testing.T) {
	for _, id := range []authn.Identity{{}, {Issuer: keycloak}, {Subject: me.Subject}} {
		src := &fakeSource{grants: []authz.Grant{live(tenantA, "", authz.MOWN)}}
		p, err := resolver(t, src).Resolve(context.Background(), id)
		if !errors.Is(err, authz.ErrInvalidIdentity) {
			t.Errorf("identity %+v: err = %v; want ErrInvalidIdentity", id, err)
		}
		if src.calls != 0 {
			t.Errorf("identity %+v: grants were read for an incomplete identity", id)
		}
		assertNothing(t, "incomplete identity", p)
	}
}

func TestGrantsAreReadForTheVerifiedSubjectOnly(t *testing.T) {
	src := &fakeSource{}
	if _, err := resolver(t, src).Resolve(context.Background(), me); err != nil {
		t.Fatal(err)
	}
	if want := (db.Subject{Issuer: me.Issuer, Subject: me.Subject}); src.asked != want {
		t.Errorf("source asked for %+v; want the verified %+v", src.asked, want)
	}
}

// 02-02 AT-005, AT-015: a removed grant denies on the next request even
// though the token is still valid. Nothing is cached between calls.
func TestRevocationTakesEffectOnTheNextResolve(t *testing.T) {
	src := &fakeSource{grants: []authz.Grant{live(tenantA, "", authz.MOWN)}}
	r := resolver(t, src)
	if p, _ := r.Resolve(context.Background(), me); !p.Holds(authz.MOWN, tenantA, merA1) {
		t.Fatal("grant not applied")
	}
	src.grants = nil // revoked
	p, err := r.Resolve(context.Background(), me)
	if err != nil {
		t.Fatal(err)
	}
	assertNothing(t, "after revocation", p)
	if src.calls != 2 {
		t.Errorf("grants read %d times; want once per Resolve", src.calls)
	}
}

// Resolve takes only the verified identity. There is no request, header,
// body or token-claims parameter through which a tenant or role could enter
// (02-02 §2.2, 03-05 §2.2).
func TestResolveAcceptsOnlyTheVerifiedIdentity(t *testing.T) {
	m, ok := reflect.TypeFor[*authz.Resolver]().MethodByName("Resolve")
	if !ok {
		t.Fatal("Resolve not found")
	}
	var in []reflect.Type
	for i := 1; i < m.Type.NumIn(); i++ { // skip the receiver
		in = append(in, m.Type.In(i))
	}
	want := []reflect.Type{reflect.TypeFor[context.Context](), reflect.TypeFor[authn.Identity]()}
	if !slices.Equal(in, want) {
		t.Errorf("Resolve parameters = %v; want exactly %v", in, want)
	}
}

func TestPrincipalCannotBeChangedThroughItsAccessors(t *testing.T) {
	p := resolve(t, live(tenantA, merA1, authz.MVIEW))
	gs := p.Grants()
	gs[0].MerchantID = ""      // try to widen to tenant-wide
	gs[0].Persona = authz.MOWN // and escalate
	if p.Holds(authz.MOWN, tenantA, merA2) || !p.Holds(authz.MVIEW, tenantA, merA1) {
		t.Error("changing the slice returned by Grants() changed the principal")
	}
	ts := p.Tenants()
	ts[0] = tenantB
	if p.Holds(authz.MVIEW, tenantB, merA1) {
		t.Error("changing the slice returned by Tenants() changed the principal")
	}
}

func TestNewResolverRefusesBadConfiguration(t *testing.T) {
	clock := func() time.Time { return now }
	for name, f := range map[string]func() (*authz.Resolver, error){
		"no source":         func() (*authz.Resolver, error) { return authz.NewResolver(nil, "TEST", clock) },
		"empty environment": func() (*authz.Resolver, error) { return authz.NewResolver(&fakeSource{}, "", clock) },
		"unknown env":       func() (*authz.Resolver, error) { return authz.NewResolver(&fakeSource{}, "PROD", clock) },
		"lower-case env":    func() (*authz.Resolver, error) { return authz.NewResolver(&fakeSource{}, "test", clock) },
	} {
		if _, err := f(); err == nil {
			t.Errorf("%s: NewResolver accepted it", name)
		}
	}
	if _, err := authz.NewResolver(&fakeSource{}, "LIVE", nil); err != nil {
		t.Errorf("nil clock must default to time.Now: %v", err)
	}
}
