package governance

import (
	"context"

	"github.com/zoiko/zoikopay/internal/governance/store"
	"github.com/zoiko/zoikopay/internal/platform/audit"
	"github.com/zoiko/zoikopay/internal/platform/db"
)

// AuditLog is BC-08's append-only business audit log (governance.audit_events,
// OPEN_QUESTIONS Q38), offered to other modules through this root package so
// none imports governance internals (ADR 0002). It implements audit.Recorder.
type AuditLog struct {
	store *store.AuditStore
}

var _ audit.Recorder = (*AuditLog)(nil)

// AuditEntry is an entry as read back, with the database's UTC timestamp.
type AuditEntry = store.StoredEntry

// NewAuditLog returns the audit log on pool, which must connect as zp_audit:
// the only role that may INSERT and SELECT the log (Q38 38.2).
func NewAuditLog(pool db.Beginner) *AuditLog {
	return &AuditLog{store: store.NewAuditStore(pool)}
}

// Record validates e and appends it.
func (l *AuditLog) Record(ctx context.Context, e audit.Entry) error {
	return l.store.Record(ctx, e)
}

// ListForTenant returns up to limit of a tenant's newest entries; a tenant can
// read only its own (Q38 38.11).
func (l *AuditLog) ListForTenant(ctx context.Context, environment, tenantID string, limit int) ([]AuditEntry, error) {
	return l.store.ListForTenant(ctx, environment, tenantID, limit)
}
