package outbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/platform/db"
)

// Writer appends events to one module's outbox_events table.
type Writer struct {
	Schema string
	Now    func() time.Time // sets recordedat; defaults to time.Now
}

// ErrDuplicate means an event with the same (source, aggregate, version,
// type) or the same id is already in the outbox.
var ErrDuplicate = errors.New("outbox: duplicate event")

// Append validates e, fixes recordedat to the commit-time clock and inserts
// the exact envelope bytes in tx, the same transaction as the state change
// (04-06 §7; 04-08 §7 "insert in same transaction as operation"). tx must
// carry the event's tenant (db.SetTenant); row-level security refuses an
// event for another tenant. It returns the stored bytes.
func (w Writer) Append(ctx context.Context, tx pgx.Tx, e Event) ([]byte, error) {
	now := time.Now
	if w.Now != nil {
		now = w.Now
	}
	e.RecordedAt = now().UTC()
	if err := e.Validate(); err != nil {
		return nil, err
	}
	b, err := e.marshal()
	if err != nil {
		return nil, fmt.Errorf("marshal event: %w", err)
	}
	sum := sha256.Sum256(b)
	tag, err := tx.Exec(ctx, `INSERT INTO `+db.Table(w.Schema, "outbox_events")+` (
		event_id, source, tenant_id, cell_id, legal_entity_id, aggregate_id, aggregate_version, event_type,
		dataschema, envelope, payload_sha256, created_at_utc, next_attempt_at_utc)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
		ON CONFLICT DO NOTHING`,
		e.ID, e.Source, e.TenantID, e.CellID, e.LegalEntityID, e.AggregateID, e.AggregateVersion, e.Type,
		e.DataSchema, b, hex.EncodeToString(sum[:]), e.RecordedAt)
	if err != nil {
		return nil, fmt.Errorf("append event: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return nil, fmt.Errorf("%w: %s %s v%d", ErrDuplicate, e.Type, e.AggregateID, e.AggregateVersion)
	}
	return b, nil
}

// TableSQL returns the DDL for the outbox in schema (04-06 §7.2), its requeue
// audit log, the guards and row-level security. Differences from the 04-06
// reference columns, all deliberate:
//   - envelope is bytea, not jsonb: jsonb reorders keys, and a retry must
//     resend the exact bytes (04-06 §7.1);
//   - dataschema (URI) instead of schema_digest until a schema registry exists;
//   - tenant_id, so row-level security can isolate tenants;
//   - parked_at_utc / park_reason: events that keep failing stop retrying
//     and wait for a person (failed-event parking, ADR 0005 §5).
//
// The guard refuses DELETE and TRUNCATE (retention is not approved) and any
// change to an event's identity or bytes; only delivery-state columns change.
// Generate a module's migration with `go run ./cmd/migrate scaffold`.
func TableSQL(schema string) string {
	t := db.Table(schema, "outbox_events")
	log := db.Table(schema, "outbox_requeue_log")
	fn := db.Table(schema, "zp_outbox_guard")
	return `CREATE TABLE ` + t + ` (
    event_id            uuid        PRIMARY KEY CHECK (uuid_extract_version(event_id) = 7),
    source              text        NOT NULL,
    tenant_id           text        NOT NULL,
    cell_id             text        NOT NULL,
    legal_entity_id     text        NOT NULL,
    aggregate_id        text        NOT NULL,
    aggregate_version   bigint      NOT NULL CHECK (aggregate_version > 0),
    event_type          text        NOT NULL,
    dataschema          text        NOT NULL,
    envelope            bytea       NOT NULL,
    payload_sha256      text        NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    created_at_utc      timestamptz NOT NULL,
    published_at_utc    timestamptz NULL,
    attempts            integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at_utc timestamptz NOT NULL,
    last_error          text        NULL,
    parked_at_utc       timestamptz NULL,
    park_reason         text        NULL,
    UNIQUE (source, aggregate_id, aggregate_version, event_type),
    CHECK (published_at_utc IS NULL OR parked_at_utc IS NULL)
);
CREATE INDEX outbox_due ON ` + t + ` (next_attempt_at_utc, created_at_utc) WHERE published_at_utc IS NULL AND parked_at_utc IS NULL;
CREATE INDEX outbox_unpublished_by_aggregate ON ` + t + ` (source, aggregate_id, aggregate_version) WHERE published_at_utc IS NULL;
CREATE INDEX outbox_parked ON ` + t + ` (parked_at_utc) WHERE parked_at_utc IS NOT NULL;
CREATE TABLE ` + log + ` (
    requeue_id        uuid        PRIMARY KEY CHECK (uuid_extract_version(requeue_id) = 7),
    event_id          uuid        NOT NULL REFERENCES ` + t + ` (event_id),
    requeued_by       text        NOT NULL CHECK (requeued_by <> ''),
    reason            text        NOT NULL CHECK (length(reason) >= 10),
    attempts_before   integer     NOT NULL,
    last_error_before text        NULL,
    park_reason_before text       NULL,
    requeued_at_utc   timestamptz NOT NULL
);
CREATE FUNCTION ` + fn + `() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_TABLE_NAME = 'outbox_requeue_log' THEN
        RAISE EXCEPTION 'the requeue log is append-only' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.event_id, NEW.source, NEW.tenant_id, NEW.cell_id, NEW.legal_entity_id, NEW.aggregate_id,
        NEW.aggregate_version, NEW.event_type, NEW.dataschema, NEW.envelope, NEW.payload_sha256, NEW.created_at_utc)
       IS DISTINCT FROM
       (OLD.event_id, OLD.source, OLD.tenant_id, OLD.cell_id, OLD.legal_entity_id, OLD.aggregate_id,
        OLD.aggregate_version, OLD.event_type, OLD.dataschema, OLD.envelope, OLD.payload_sha256, OLD.created_at_utc) THEN
        RAISE EXCEPTION 'a stored event cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.published_at_utc IS NOT NULL AND NEW.published_at_utc IS DISTINCT FROM OLD.published_at_utc THEN
        RAISE EXCEPTION 'a published event cannot be unpublished' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER outbox_guard BEFORE UPDATE OR DELETE ON ` + t + ` FOR EACH ROW EXECUTE FUNCTION ` + fn + `();
CREATE TRIGGER outbox_guard_truncate BEFORE TRUNCATE ON ` + t + ` FOR EACH STATEMENT EXECUTE FUNCTION ` + fn + `();
CREATE TRIGGER requeue_log_guard BEFORE UPDATE OR DELETE ON ` + log + ` FOR EACH ROW EXECUTE FUNCTION ` + fn + `();
CREATE TRIGGER requeue_log_guard_truncate BEFORE TRUNCATE ON ` + log + ` FOR EACH STATEMENT EXECUTE FUNCTION ` + fn + `();
` + db.TenantRLSSQL(schema, "outbox_events")
}

// GrantSQL grants the producing module's role INSERT/SELECT, and the relay
// role read access plus UPDATE on delivery-state columns only (so it can
// never alter an event's bytes), and insert/read on the requeue log. Row-level
// security lets the relay see every tenant's events (it carries no tenant).
func GrantSQL(schema, writerRole, relayRole string) string {
	t := db.Table(schema, "outbox_events")
	log := db.Table(schema, "outbox_requeue_log")
	return `GRANT SELECT, INSERT ON ` + t + ` TO ` + writerRole + `;
GRANT SELECT ON ` + t + ` TO ` + relayRole + `;
GRANT UPDATE (published_at_utc, attempts, next_attempt_at_utc, last_error, parked_at_utc, park_reason) ON ` + t + ` TO ` + relayRole + `;
GRANT SELECT, INSERT ON ` + log + ` TO ` + relayRole + `;
` + db.SystemRLSSQL(schema, "outbox_events", relayRole)
}
