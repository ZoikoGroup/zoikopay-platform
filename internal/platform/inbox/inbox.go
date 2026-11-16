package inbox

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/platform/db"
)

// Inbox is the event_inbox table in one consuming module's schema
// (04-08 §7: consumer_id + event_id UNIQUE).
type Inbox struct {
	Schema string
	Now    func() time.Time // defaults to time.Now
}

// ErrNoTenant is returned when Process runs without a tenant context.
var ErrNoTenant = errors.New("inbox: transaction has no tenant context; set it from the verified event before processing")

// Process runs handle at most once per (consumerID, eventID). The inbox row
// and handle's writes share tx, so they commit together: if handle fails and
// the caller rolls back, the event is not marked and will be retried.
//
// tx must carry the event's tenant (db.SetTenant with the tenantid of the
// verified envelope); the row is stamped with it and row-level security keeps
// tenants apart. It reports whether handle ran (false: duplicate, skipped).
func (in Inbox) Process(ctx context.Context, tx pgx.Tx, consumerID, eventID, eventType string, handle func(context.Context, pgx.Tx) error) (bool, error) {
	if consumerID == "" || eventID == "" || eventType == "" {
		return false, errors.New("inbox: consumer, event id and type are required")
	}
	var tenant *string
	if err := tx.QueryRow(ctx, `SELECT current_setting('`+db.SettingTenant+`', true)`).Scan(&tenant); err != nil {
		return false, fmt.Errorf("read tenant context: %w", err)
	}
	if tenant == nil || *tenant == "" {
		return false, ErrNoTenant
	}
	now := time.Now
	if in.Now != nil {
		now = in.Now
	}
	tag, err := tx.Exec(ctx, `INSERT INTO `+db.Table(in.Schema, "event_inbox")+`
		(consumer_id, event_id, event_type, tenant_id, processed_at_utc) VALUES ($1, $2::uuid, $3, $4, $5)
		ON CONFLICT DO NOTHING`, consumerID, eventID, eventType, *tenant, now().UTC())
	if err != nil {
		return false, fmt.Errorf("record inbox event: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil // already processed
	}
	if err := handle(ctx, tx); err != nil {
		return false, err
	}
	return true, nil
}

// TableSQL returns the DDL for the inbox in schema, with tenant row-level
// security and a guard: inbox rows are the proof an event was processed, so
// they are never changed or deleted. Generate a module's migration with
// `go run ./cmd/migrate scaffold`.
//
// The primary key is (consumer_id, event_id) without tenant: an event ID is
// globally unique, so a replay under another tenant can never be processed
// twice. A duplicate from another tenant is invisible under row-level
// security, so the insert conflicts and the event is skipped, never re-run.
func TableSQL(schema string) string {
	t := db.Table(schema, "event_inbox")
	fn := db.Table(schema, "zp_inbox_guard")
	return `CREATE TABLE ` + t + ` (
    consumer_id      text        NOT NULL,
    event_id         uuid        NOT NULL,
    event_type       text        NOT NULL,
    tenant_id        text        NOT NULL,
    processed_at_utc timestamptz NOT NULL,
    PRIMARY KEY (consumer_id, event_id)
);
CREATE FUNCTION ` + fn + `() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'inbox rows are never changed or deleted' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER inbox_guard BEFORE UPDATE OR DELETE ON ` + t + ` FOR EACH ROW EXECUTE FUNCTION ` + fn + `();
CREATE TRIGGER inbox_guard_truncate BEFORE TRUNCATE ON ` + t + ` FOR EACH STATEMENT EXECUTE FUNCTION ` + fn + `();
` + db.TenantRLSSQL(schema, "event_inbox")
}

// GrantSQL grants the consuming module's role SELECT and INSERT only.
func GrantSQL(schema, consumerRole string) string {
	return `GRANT SELECT, INSERT ON ` + db.Table(schema, "event_inbox") + ` TO ` + consumerRole + `;`
}
