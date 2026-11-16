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
// (04-06 §7; 04-08 §7 "insert in same transaction as operation"). It returns
// the stored bytes.
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
		event_id, source, cell_id, legal_entity_id, aggregate_id, aggregate_version, event_type,
		dataschema, envelope, payload_sha256, created_at_utc, next_attempt_at_utc)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
		ON CONFLICT DO NOTHING`,
		e.ID, e.Source, e.CellID, e.LegalEntityID, e.AggregateID, e.AggregateVersion, e.Type,
		e.DataSchema, b, hex.EncodeToString(sum[:]), e.RecordedAt)
	if err != nil {
		return nil, fmt.Errorf("append event: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return nil, fmt.Errorf("%w: %s %s v%d", ErrDuplicate, e.Type, e.AggregateID, e.AggregateVersion)
	}
	return b, nil
}

// TableSQL returns the DDL for this table in schema (04-06 §7.2). Two
// deliberate differences from the reference columns:
//   - envelope is bytea, not jsonb: jsonb reorders keys, and a retry must
//     resend the exact bytes (04-06 §7.1);
//   - dataschema (URI) is stored instead of schema_digest until the schema
//     registry exists.
//
// A module's first goose migration must contain exactly this statement.
func TableSQL(schema string) string {
	t := db.Table(schema, "outbox_events")
	return `CREATE TABLE ` + t + ` (
    event_id           uuid        PRIMARY KEY,
    source             text        NOT NULL,
    cell_id            text        NOT NULL,
    legal_entity_id    text        NOT NULL,
    aggregate_id       text        NOT NULL,
    aggregate_version  bigint      NOT NULL CHECK (aggregate_version > 0),
    event_type         text        NOT NULL,
    dataschema         text        NOT NULL,
    envelope           bytea       NOT NULL,
    payload_sha256     text        NOT NULL,
    created_at_utc     timestamptz NOT NULL,
    published_at_utc   timestamptz NULL,
    attempts           integer     NOT NULL DEFAULT 0,
    next_attempt_at_utc timestamptz NOT NULL,
    last_error         text        NULL,
    UNIQUE (source, aggregate_id, aggregate_version, event_type)
);
CREATE INDEX ON ` + t + ` (next_attempt_at_utc, created_at_utc) WHERE published_at_utc IS NULL;
CREATE INDEX ON ` + t + ` (source, aggregate_id, aggregate_version) WHERE published_at_utc IS NULL;`
}
