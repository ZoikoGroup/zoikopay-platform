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

// Process runs handle at most once per (consumerID, eventID). The inbox row
// and handle's writes share tx, so they commit together: if handle fails and
// the caller rolls back, the event is not marked and will be retried.
// It reports whether handle ran (false means a duplicate delivery was skipped).
func (in Inbox) Process(ctx context.Context, tx pgx.Tx, consumerID, eventID, eventType string, handle func(context.Context, pgx.Tx) error) (bool, error) {
	if consumerID == "" || eventID == "" || eventType == "" {
		return false, errors.New("inbox: consumer, event id and type are required")
	}
	now := time.Now
	if in.Now != nil {
		now = in.Now
	}
	tag, err := tx.Exec(ctx, `INSERT INTO `+db.Table(in.Schema, "event_inbox")+`
		(consumer_id, event_id, event_type, processed_at_utc) VALUES ($1, $2::uuid, $3, $4)
		ON CONFLICT DO NOTHING`, consumerID, eventID, eventType, now().UTC())
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

// TableSQL returns the DDL for this table in schema. A consuming module's
// migration must contain exactly this statement.
func TableSQL(schema string) string {
	return `CREATE TABLE ` + db.Table(schema, "event_inbox") + ` (
    consumer_id      text        NOT NULL,
    event_id         uuid        NOT NULL,
    event_type       text        NOT NULL,
    processed_at_utc timestamptz NOT NULL,
    PRIMARY KEY (consumer_id, event_id)
);`
}
