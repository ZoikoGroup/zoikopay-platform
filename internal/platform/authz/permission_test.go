package authz_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/platform/authz"
)

// 02-02 §3 MERCHANT.PROFILE.READ: MOWN, MOPS, MFIN, MVIEW (not MDEV); POR is
// staff and never holds a tenant grant (Q36 36.1, Q37 37.10).
func TestMerchantProfileReadPersonas(t *testing.T) {
	for persona, want := range map[authz.Persona]bool{
		authz.MOWN: true, authz.MOPS: true, authz.MFIN: true, authz.MVIEW: true, authz.MDEV: false,
	} {
		p := resolve(t, live(tenantA, "", persona))
		if got := p.Can(authz.MerchantProfileRead, tenantA, merA1); got != want {
			t.Errorf("%s: Can(MERCHANT.PROFILE.READ) = %v; want %v", persona, got, want)
		}
		if !p.Covers(tenantA, merA1) {
			t.Errorf("%s: a tenant-wide grant must cover the tenant's merchants", persona)
		}
	}
}

func TestPermissionsFollowGrantScope(t *testing.T) {
	p := resolve(t, live(tenantA, merA1, authz.MVIEW), live(tenantB, "", authz.MDEV))
	for _, c := range []struct {
		tenant, merchant string
		covers, can      bool
	}{
		{tenantA, merA1, true, true},
		{tenantA, merA2, false, false}, // 02-02 AT-007: sibling merchant, no relation
		{tenantA, "", false, false},    // merchant grant is not tenant-wide
		{tenantB, merB1, true, false},  // covered, but MDEV lacks the permission → 403
		{"ten_other", merA1, false, false},
		{"", "", false, false},
	} {
		if got := p.Covers(c.tenant, c.merchant); got != c.covers {
			t.Errorf("Covers(%q, %q) = %v; want %v", c.tenant, c.merchant, got, c.covers)
		}
		if got := p.Can(authz.MerchantProfileRead, c.tenant, c.merchant); got != c.can {
			t.Errorf("Can(%q, %q) = %v; want %v", c.tenant, c.merchant, got, c.can)
		}
	}
	if (authz.Principal{}).Can(authz.MerchantProfileRead, tenantA, merA1) || (authz.Principal{}).Covers(tenantA, merA1) {
		t.Error("the zero principal can do something")
	}
	if p.Can(authz.Permission("NO.SUCH.PERMISSION"), tenantA, merA1) {
		t.Error("an unknown permission was allowed (deny by default)")
	}
}

// beginner records whether a transaction was started.
type beginner struct{ began int }

func (b *beginner) Begin(context.Context) (pgx.Tx, error) {
	b.began++
	return nil, errors.New("not a real database")
}

// Rule 6: a tenant transaction opens only for a tenant the principal holds a
// grant in; anything else is refused before the database is touched.
func TestInTenantTxRefusesTenantsOutsideThePrincipal(t *testing.T) {
	p := resolve(t, live(tenantA, merA1, authz.MVIEW))
	for name, c := range map[string]struct {
		p      authz.Principal
		tenant string
	}{
		"another tenant": {p, tenantB},
		"empty tenant":   {p, ""},
		"zero principal": {authz.Principal{}, tenantA},
		"wildcard":       {p, "*"},
	} {
		b := &beginner{}
		called := false
		err := authz.InTenantTx(context.Background(), b, c.p, c.tenant, func(pgx.Tx) error { called = true; return nil })
		if !errors.Is(err, authz.ErrNotInTenant) {
			t.Errorf("%s: err = %v; want ErrNotInTenant", name, err)
		}
		if b.began != 0 || called {
			t.Errorf("%s: a transaction was started", name)
		}
	}
	b := &beginner{}
	if err := authz.InTenantTx(context.Background(), b, p, tenantA, func(pgx.Tx) error { return nil }); b.began != 1 || err == nil {
		t.Errorf("own tenant: began %d, err %v; want one Begin attempt (which this fake fails)", b.began, err)
	}
}
