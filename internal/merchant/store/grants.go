package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/db"
)

// GrantSource reads a subject's live tenant grants from merchant.memberships
// for the principal resolver (it implements authz.GrantSource). It runs as
// BC-01's runtime role inside a subject transaction, so row-level security
// limits the rows to that subject's own live grants before the query's own
// filter applies.
type GrantSource struct {
	pool db.Beginner
	now  func() time.Time
}

var _ authz.GrantSource = GrantSource{}

// NewGrantSource returns a GrantSource on pool, which must connect as zp_gateway.
func NewGrantSource(pool db.Beginner) GrantSource {
	return GrantSource{pool: pool, now: time.Now}
}

// GrantsForSubject returns s's live grants in every tenant and environment.
// An incomplete subject is refused before any query (db.ErrNoSubject).
func (g GrantSource) GrantsForSubject(ctx context.Context, s db.Subject) ([]authz.Grant, error) {
	var out []authz.Grant
	err := db.InSubjectTx(ctx, g.pool, s, func(tx pgx.Tx) error {
		rows, err := New(tx).LiveGrantsForSubject(ctx, LiveGrantsForSubjectParams{
			Issuer: s.Issuer, Subject: s.Subject, Now: g.now().UTC(),
		})
		if err != nil {
			return err
		}
		for _, r := range rows {
			gr := authz.Grant{
				ID:            r.ID,
				Subject:       db.Subject{Issuer: r.Issuer, Subject: r.Subject},
				TenantID:      r.TenantID,
				Environment:   r.Environment,
				Persona:       authz.Persona(r.Persona),
				EffectiveFrom: r.EffectiveFromUtc.UTC(),
				ExpiresAt:     r.ExpiresAtUtc.UTC(),
			}
			if r.MerchantID != nil {
				gr.MerchantID = *r.MerchantID
			}
			out = append(out, gr)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read grants: %w", err)
	}
	return out, nil
}
