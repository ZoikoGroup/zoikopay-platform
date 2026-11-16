package outbox

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/platform/db"
)

// Message is one committed event handed to a Publisher.
type Message struct {
	EventID     string
	Type        string
	AggregateID string
	Envelope    []byte // exact stored bytes; never re-marshaled
}

// Publisher delivers a message to its consumers. It returns nil only after
// the destination has durably accepted it (04-06 §7.1). Delivery is at least
// once: consumers deduplicate with the inbox.
type Publisher interface {
	Publish(ctx context.Context, m Message) error
}

// Relay moves committed outbox rows of one schema to a Publisher
// (ADR 0002 §3: PostgreSQL outbox, polling relay, no broker).
//
// Ordering: an event is published only when no earlier version of the same
// aggregate is still unpublished, so a failure holds back that aggregate
// only. Concurrency: rows are locked with FOR UPDATE SKIP LOCKED, so several
// relays can run without publishing a row twice at the same time.
//
// Pilot simplification: the row lock is held while publishing (no separate
// lease epoch). Fine for in-process consumers; revisit with a remote broker.
type Relay struct {
	Pool      db.Beginner
	Schema    string
	Publisher Publisher
	Batch     int                              // rows per RunOnce; default 100
	Now       func() time.Time                 // defaults to time.Now
	Backoff   func(attempts int) time.Duration // defaults to DefaultBackoff
}

// DefaultBackoff doubles from 1s to a 5-minute cap.
func DefaultBackoff(attempts int) time.Duration {
	d := time.Second
	for i := 1; i < attempts && d < 5*time.Minute; i++ {
		d *= 2
	}
	return min(d, 5*time.Minute)
}

// Stats reports one RunOnce pass.
type Stats struct {
	Published int
	Failed    int
}

// RunOnce publishes up to Batch due events and returns what happened.
func (r Relay) RunOnce(ctx context.Context) (Stats, error) {
	batch := r.Batch
	if batch <= 0 {
		batch = 100
	}
	now := time.Now
	if r.Now != nil {
		now = r.Now
	}
	backoff := r.Backoff
	if backoff == nil {
		backoff = DefaultBackoff
	}
	t := db.Table(r.Schema, "outbox_events")
	var st Stats
	err := db.InTx(ctx, r.Pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT o.event_id::text, o.event_type, o.source, o.aggregate_id, o.envelope, o.attempts
			FROM `+t+` o
			WHERE o.published_at_utc IS NULL AND o.next_attempt_at_utc <= $1
			  AND NOT EXISTS (SELECT 1 FROM `+t+` p
			                  WHERE p.source = o.source AND p.aggregate_id = o.aggregate_id
			                    AND p.published_at_utc IS NULL AND p.aggregate_version < o.aggregate_version)
			ORDER BY o.created_at_utc, o.aggregate_version
			LIMIT $2
			FOR UPDATE SKIP LOCKED`, now().UTC(), batch)
		if err != nil {
			return fmt.Errorf("select due events: %w", err)
		}
		type row struct {
			m        Message
			source   string
			attempts int
		}
		var due []row
		for rows.Next() {
			var x row
			if err := rows.Scan(&x.m.EventID, &x.m.Type, &x.source, &x.m.AggregateID, &x.m.Envelope, &x.attempts); err != nil {
				rows.Close()
				return fmt.Errorf("scan event: %w", err)
			}
			due = append(due, x)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("read due events: %w", err)
		}

		blocked := map[string]bool{} // source|aggregate that failed in this pass
		for _, x := range due {
			agg := x.source + "|" + x.m.AggregateID
			if blocked[agg] {
				continue // keep per-aggregate order: an earlier event failed
			}
			if perr := r.Publisher.Publish(ctx, x.m); perr != nil {
				blocked[agg] = true
				st.Failed++
				next := now().UTC().Add(backoff(x.attempts + 1))
				if _, err := tx.Exec(ctx, `UPDATE `+t+` SET attempts = attempts + 1, last_error = $2, next_attempt_at_utc = $3
					WHERE event_id = $1::uuid`, x.m.EventID, truncate(perr.Error(), 500), next); err != nil {
					return fmt.Errorf("record publish failure: %w", err)
				}
				continue
			}
			st.Published++
			if _, err := tx.Exec(ctx, `UPDATE `+t+` SET published_at_utc = $2, attempts = attempts + 1, last_error = NULL
				WHERE event_id = $1::uuid`, x.m.EventID, now().UTC()); err != nil {
				return fmt.Errorf("mark published: %w", err)
			}
		}
		return nil
	})
	return st, err
}

// OldestUnpublishedAge is the age of the oldest unpublished event, the key
// relay health signal (04-06 §7.3). Zero when nothing is waiting.
func (r Relay) OldestUnpublishedAge(ctx context.Context, q db.DBTX) (time.Duration, error) {
	var oldest *time.Time
	if err := q.QueryRow(ctx, `SELECT min(created_at_utc) FROM `+db.Table(r.Schema, "outbox_events")+
		` WHERE published_at_utc IS NULL`).Scan(&oldest); err != nil {
		return 0, fmt.Errorf("oldest unpublished event: %w", err)
	}
	if oldest == nil {
		return 0, nil
	}
	now := time.Now
	if r.Now != nil {
		now = r.Now
	}
	return now().Sub(*oldest), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
