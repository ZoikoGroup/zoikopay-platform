package outbox

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/ids"
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
// (ADR 0002 §3: PostgreSQL outbox, polling relay, no broker). It runs as the
// relay role, which row-level security lets see every tenant's events.
//
// Ordering: an event is published only when no earlier version of the same
// aggregate is unpublished (including parked ones), so a failure holds back
// that aggregate only. Concurrency: rows are locked with FOR UPDATE SKIP
// LOCKED, so several relays never publish a row at the same time.
//
// Parking: after MaxAttempts failures an event is parked: it stops retrying,
// stays visible through ListParked, and waits for Requeue by a person.
//
// Pilot simplification: the row lock is held while publishing (no separate
// lease epoch). Fine for in-process consumers; revisit with a remote broker.
type Relay struct {
	Pool        db.Beginner
	Schema      string
	Publisher   Publisher
	Batch       int                              // rows per RunOnce; default 100
	MaxAttempts int                              // failures before parking; default 10
	Now         func() time.Time                 // defaults to time.Now
	Backoff     func(attempts int) time.Duration // defaults to DefaultBackoff
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
	Parked    int
}

func (r Relay) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func (r Relay) table() string { return db.Table(r.Schema, "outbox_events") }

// RunOnce publishes up to Batch due events and returns what happened.
func (r Relay) RunOnce(ctx context.Context) (Stats, error) {
	batch := r.Batch
	if batch <= 0 {
		batch = 100
	}
	maxAttempts := r.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = 10
	}
	backoff := r.Backoff
	if backoff == nil {
		backoff = DefaultBackoff
	}
	t := r.table()
	var st Stats
	err := db.InTx(ctx, r.Pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT o.event_id::text, o.event_type, o.source, o.aggregate_id, o.envelope, o.attempts
			FROM `+t+` o
			WHERE o.published_at_utc IS NULL AND o.parked_at_utc IS NULL AND o.next_attempt_at_utc <= $1
			  AND NOT EXISTS (SELECT 1 FROM `+t+` p
			                  WHERE p.source = o.source AND p.aggregate_id = o.aggregate_id
			                    AND p.published_at_utc IS NULL AND p.aggregate_version < o.aggregate_version)
			ORDER BY o.created_at_utc, o.aggregate_version
			LIMIT $2
			FOR UPDATE SKIP LOCKED`, r.now(), batch)
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
			perr := r.Publisher.Publish(ctx, x.m)
			if perr == nil {
				st.Published++
				if _, err := tx.Exec(ctx, `UPDATE `+t+` SET published_at_utc = $2, attempts = attempts + 1, last_error = NULL
					WHERE event_id = $1::uuid`, x.m.EventID, r.now()); err != nil {
					return fmt.Errorf("mark published: %w", err)
				}
				continue
			}
			blocked[agg] = true
			st.Failed++
			attempts := x.attempts + 1
			msg := truncate(perr.Error(), 500)
			if attempts >= maxAttempts {
				st.Parked++
				if _, err := tx.Exec(ctx, `UPDATE `+t+` SET attempts = $2, last_error = $3, parked_at_utc = $4,
					park_reason = 'max attempts reached' WHERE event_id = $1::uuid`, x.m.EventID, attempts, msg, r.now()); err != nil {
					return fmt.Errorf("park event: %w", err)
				}
				continue
			}
			if _, err := tx.Exec(ctx, `UPDATE `+t+` SET attempts = $2, last_error = $3, next_attempt_at_utc = $4
				WHERE event_id = $1::uuid`, x.m.EventID, attempts, msg, r.now().Add(backoff(attempts))); err != nil {
				return fmt.Errorf("record publish failure: %w", err)
			}
		}
		return nil
	})
	return st, err
}

// Parked describes one parked event (no payload: it may be restricted-financial).
type Parked struct {
	EventID     string
	Type        string
	AggregateID string
	Version     int64
	Attempts    int
	LastError   string
	ParkedAt    time.Time
}

// ListParked returns parked events, oldest first.
func (r Relay) ListParked(ctx context.Context, q db.DBTX, limit int) ([]Parked, error) {
	rows, err := q.Query(ctx, `SELECT event_id::text, event_type, aggregate_id, aggregate_version, attempts,
		coalesce(last_error, ''), parked_at_utc FROM `+r.table()+`
		WHERE parked_at_utc IS NOT NULL ORDER BY parked_at_utc LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list parked events: %w", err)
	}
	defer rows.Close()
	var out []Parked
	for rows.Next() {
		var p Parked
		if err := rows.Scan(&p.EventID, &p.Type, &p.AggregateID, &p.Version, &p.Attempts, &p.LastError, &p.ParkedAt); err != nil {
			return nil, fmt.Errorf("scan parked event: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ErrNotParked is returned by Requeue for an event that is not parked.
var ErrNotParked = errors.New("outbox: event is not parked")

// Requeue returns a parked event to delivery with a fresh attempt budget and
// records who did it and why in the append-only requeue log, in one
// transaction. actor is the authenticated operator; reason must explain the
// fix (at least 10 characters). Authorization of the actor is the caller's job.
func (r Relay) Requeue(ctx context.Context, eventID, actor, reason string) error {
	if actor == "" || len(reason) < 10 {
		return errors.New("outbox: requeue needs an actor and a reason of at least 10 characters")
	}
	return db.InTx(ctx, r.Pool, func(tx pgx.Tx) error {
		var attempts int
		var lastErr, parkReason *string
		err := tx.QueryRow(ctx, `SELECT attempts, last_error, park_reason FROM `+r.table()+`
			WHERE event_id = $1::uuid AND parked_at_utc IS NOT NULL FOR UPDATE`, eventID).Scan(&attempts, &lastErr, &parkReason)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: %s", ErrNotParked, eventID)
		}
		if err != nil {
			return fmt.Errorf("read parked event: %w", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO `+db.Table(r.Schema, "outbox_requeue_log")+`
			(requeue_id, event_id, requeued_by, reason, attempts_before, last_error_before, park_reason_before, requeued_at_utc)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
			ids.NewInternal(), eventID, actor, reason, attempts, lastErr, parkReason, r.now()); err != nil {
			return fmt.Errorf("log requeue: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE `+r.table()+` SET parked_at_utc = NULL, park_reason = NULL, attempts = 0,
			next_attempt_at_utc = $2 WHERE event_id = $1::uuid`, eventID, r.now()); err != nil {
			return fmt.Errorf("requeue event: %w", err)
		}
		return nil
	})
}

// OldestUnpublishedAge is the age of the oldest unpublished event, the key
// relay health signal (04-06 §7.3). Zero when nothing is waiting.
func (r Relay) OldestUnpublishedAge(ctx context.Context, q db.DBTX) (time.Duration, error) {
	var oldest *time.Time
	if err := q.QueryRow(ctx, `SELECT min(created_at_utc) FROM `+r.table()+
		` WHERE published_at_utc IS NULL`).Scan(&oldest); err != nil {
		return 0, fmt.Errorf("oldest unpublished event: %w", err)
	}
	if oldest == nil {
		return 0, nil
	}
	return r.now().Sub(*oldest), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
