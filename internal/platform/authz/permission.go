package authz

import (
	"context"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/platform/db"
)

// Permission is an action from the 02-02 §3 permission register.
type Permission string

// Permissions used by routes so far. The rest of the register is added with
// the routes that need it (OPEN_QUESTIONS Q37 37.10).
const (
	// MerchantProfileRead: 02-02 §3 Merchant actions, "Scoped to own merchant".
	MerchantProfileRead Permission = "MERCHANT.PROFILE.READ"
)

// eligible lists the merchant personas that may hold each permission. Staff
// personas named in the register (for example POR) are absent: they never
// hold tenant grants (Q36 36.1). An unknown permission is allowed to no one.
var eligible = map[Permission][]Persona{
	MerchantProfileRead: {MOWN, MOPS, MFIN, MVIEW},
}

// Covers reports whether any of the principal's grants covers a resource of
// tenantID and merchantID. A resource that is not covered is answered as if
// it did not exist (404, Q37 37.5).
func (p Principal) Covers(tenantID, merchantID string) bool {
	return len(p.Personas(tenantID, merchantID)) > 0
}

// Can reports whether the principal holds perm for a resource of tenantID and
// merchantID, both taken from the stored record. Deny by default.
func (p Principal) Can(perm Permission, tenantID, merchantID string) bool {
	allowed := eligible[perm]
	for _, persona := range p.Personas(tenantID, merchantID) {
		if slices.Contains(allowed, persona) {
			return true
		}
	}
	return false
}

// NoScope fills the cell and legal-entity settings of a tenant transaction:
// a principal has no cell authority yet (Q36 36.17), and no real record
// carries this value, so any policy that checks a cell denies (Q37 37.9).
const NoScope = "zp:none"

// ErrNotInTenant: the principal holds no live grant in the tenant.
var ErrNotInTenant = errors.New("authz: principal holds no grant in this tenant")

// InTenantTx runs fn in a tenant transaction (db.InTenantTx), so row-level
// security limits every statement to tenantID, in the principal's
// environment. It refuses, before touching the database, any tenant the
// principal holds no live grant in.
func InTenantTx(ctx context.Context, b db.Beginner, p Principal, tenantID string, fn func(pgx.Tx) error) error {
	if tenantID == "" || !slices.Contains(p.Tenants(), tenantID) {
		return ErrNotInTenant
	}
	return db.InTenantTx(ctx, b, db.Tenant{
		Environment: p.Environment, CellID: NoScope, LegalEntityID: NoScope, TenantID: tenantID,
	}, fn)
}
