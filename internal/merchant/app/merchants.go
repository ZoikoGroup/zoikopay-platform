package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/merchant/store"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/ids"
)

var (
	// ErrNotFound: the merchant does not exist for this caller. It is the
	// answer for a merchant that does not exist, one in another tenant or
	// environment, and one no grant covers, so none can be told apart
	// (02-02 §2.3; OPEN_QUESTIONS Q37 37.5).
	ErrNotFound = errors.New("merchant not found")
	// ErrForbidden: a grant covers the merchant but none carries the permission.
	ErrForbidden = errors.New("permission denied")
)

// Merchant is a merchant profile as BC-01 stores it (04-03 §6).
type Merchant struct {
	ID          string
	TenantID    string
	Environment string
	DisplayName string
	Status      string // upper case, as stored (04-03 §4)
	Revision    int64
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Merchants reads merchant profiles for a resolved principal.
type Merchants struct {
	Pool db.Beginner // connects as zp_gateway
}

// Get returns a merchant the principal may read (MERCHANT.PROFILE.READ).
//
// It looks only in the principal's own tenants whose grants cover the
// merchant, each in a tenant transaction so row-level security applies, and
// in the principal's environment (Q37 37.6). Other tenants are never queried.
func (m Merchants) Get(ctx context.Context, p authz.Principal, merchantID string) (Merchant, error) {
	if _, err := ids.Parse(ids.Merchant, merchantID); err != nil {
		return Merchant{}, ErrNotFound // a malformed id is answered like an unknown one
	}
	for _, tenant := range p.Tenants() {
		if !p.Covers(tenant, merchantID) {
			continue
		}
		var row store.GetMerchantRow
		found := false
		err := authz.InTenantTx(ctx, m.Pool, p, tenant, func(tx pgx.Tx) error {
			r, err := store.New(tx).GetMerchant(ctx, store.GetMerchantParams{MerchantID: merchantID, Environment: p.Environment})
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			row, found = r, true
			return nil
		})
		if err != nil {
			return Merchant{}, fmt.Errorf("read merchant: %w", err)
		}
		if !found || row.TenantID != tenant {
			continue // row-level security already limits rows to tenant; checked again
		}
		if !p.Can(authz.MerchantProfileRead, tenant, merchantID) {
			// The merchant is in the caller's own tenant, so naming that tenant
			// (for the audit entry) reveals nothing new (OPEN_QUESTIONS Q38 38.10).
			return Merchant{TenantID: tenant}, ErrForbidden
		}
		return Merchant{
			ID: row.MerchantID, TenantID: row.TenantID, Environment: row.Environment, DisplayName: row.DisplayName,
			Status: row.Status, Revision: row.Revision, CreatedAt: row.CreatedAtUtc.UTC(), UpdatedAt: row.UpdatedAtUtc.UTC(),
		}, nil
	}
	return Merchant{}, ErrNotFound
}
