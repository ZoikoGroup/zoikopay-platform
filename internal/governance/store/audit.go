package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/platform/audit"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/db"
)

// AuditStore records and reads governance.audit_events (OPEN_QUESTIONS Q38).
// Its pool must connect as zp_audit, which may only INSERT and SELECT that
// table. It implements audit.Recorder.
type AuditStore struct {
	pool db.Beginner
}

var _ audit.Recorder = (*AuditStore)(nil)

// NewAuditStore returns a store on pool (role zp_audit).
func NewAuditStore(pool db.Beginner) *AuditStore { return &AuditStore{pool: pool} }

// StoredEntry is an entry as read back, with the database's timestamp.
type StoredEntry struct {
	audit.Entry
	OccurredAt time.Time // UTC, from the database clock
}

func scope(environment, tenantID string) db.Tenant {
	return db.Tenant{Environment: environment, CellID: authz.NoScope, LegalEntityID: authz.NoScope, TenantID: tenantID}
}

func opt(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func val(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Record validates e and appends it. An entry with a tenant is written inside
// that tenant's transaction, so row-level security checks it; one without a
// tenant (401, 404, outages) is written outside any tenant.
func (s *AuditStore) Record(ctx context.Context, e audit.Entry) error {
	if err := e.Validate(); err != nil {
		return err
	}
	p := InsertAuditEventParams{
		TraceID: e.TraceID, Environment: e.Environment, TenantID: opt(e.TenantID), Action: e.Action,
		ResourceType: opt(e.ResourceType), ResourceHash: opt(e.ResourceHash), Outcome: string(e.Outcome),
		HttpStatus: int32(e.HTTPStatus), Reason: opt(e.Reason), //nolint:gosec // G115: Validate bounds the status to 100..599.
	}
	if e.Actor != nil {
		p.ActorIssuer, p.ActorSubject = opt(e.Actor.Issuer), opt(e.Actor.Subject)
	}
	insert := func(tx pgx.Tx) error { return New(tx).InsertAuditEvent(ctx, p) }
	var err error
	if e.TenantID == "" {
		err = db.InTx(ctx, s.pool, insert)
	} else {
		err = db.InTenantTx(ctx, s.pool, scope(e.Environment, e.TenantID), insert)
	}
	if err != nil {
		return fmt.Errorf("record audit entry: %w", err)
	}
	return nil
}

// ListForTenant returns up to limit of a tenant's newest entries, read inside
// that tenant's transaction: a tenant can read only its own entries (38.11).
func (s *AuditStore) ListForTenant(ctx context.Context, environment, tenantID string, limit int) ([]StoredEntry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	var out []StoredEntry
	err := db.InTenantTx(ctx, s.pool, scope(environment, tenantID), func(tx pgx.Tx) error {
		rows, err := New(tx).ListTenantAuditEvents(ctx, ListTenantAuditEventsParams{
			TenantID: &tenantID, Environment: environment, MaxRows: int32(limit), //nolint:gosec // G115: bounded above.
		})
		if err != nil {
			return err
		}
		for _, r := range rows {
			e := StoredEntry{OccurredAt: r.OccurredAtUtc.UTC(), Entry: audit.Entry{
				TraceID: r.TraceID, Environment: r.Environment, TenantID: val(r.TenantID), Action: r.Action,
				ResourceType: val(r.ResourceType), ResourceHash: val(r.ResourceHash), Outcome: audit.Outcome(r.Outcome),
				HTTPStatus: int(r.HttpStatus), Reason: val(r.Reason),
			}}
			if r.ActorIssuer != nil {
				e.Actor = &audit.Actor{Issuer: *r.ActorIssuer, Subject: val(r.ActorSubject)}
			}
			out = append(out, e)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("list audit entries: %w", err)
	}
	return out, nil
}
