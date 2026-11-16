//go:build integration

package outbox_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/platform/clock"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
	"github.com/zoiko/zoikopay/internal/platform/ids"
	"github.com/zoiko/zoikopay/internal/platform/inbox"
	"github.com/zoiko/zoikopay/internal/platform/outbox"
)

const schema = "m1_outbox"

func setup(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	pg := dbtest.Start(t)
	mig, err := db.Open(ctx, pg.DSN("zp_migrator"))
	if err != nil {
		t.Fatal(err)
	}
	defer mig.Close()
	for _, stmt := range []string{
		`CREATE SCHEMA ` + schema,
		outbox.TableSQL(schema),
		inbox.TableSQL(schema),
		`CREATE TABLE ` + schema + `.projection (event_id uuid PRIMARY KEY)`,
		`GRANT USAGE ON SCHEMA ` + schema + ` TO zp_execution`,
		`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ` + schema + ` TO zp_execution`,
	} {
		if _, err := mig.Exec(ctx, stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	pool, err := db.Open(ctx, pg.DSN("zp_execution"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func event(agg string, version int64) outbox.Event {
	e := validEvent()
	e.ID = ids.Generator{}.NewEventID()
	e.AggregateID, e.Subject, e.AggregateVersion = agg, "payment_intent/"+agg, version
	e.Data = json.RawMessage(fmt.Sprintf(`{"payment_intent_id":%q,"v":%d}`, agg, version))
	return e
}

type recorder struct {
	mu     sync.Mutex
	got    []outbox.Message
	failOn map[string]bool // aggregate ids that fail
}

func (r *recorder) Publish(_ context.Context, m outbox.Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failOn[m.AggregateID] {
		return errors.New("consumer unavailable")
	}
	r.got = append(r.got, m)
	return nil
}

func TestAppendIsAtomicWithTheBusinessWrite(t *testing.T) {
	ctx := context.Background()
	pool := setup(t)
	w := outbox.Writer{Schema: schema}

	boom := errors.New("state change failed")
	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		if _, err := w.Append(ctx, tx, event("pi_rolled_back", 1)); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatal(err)
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM `+schema+`.outbox_events`).Scan(&n)
	if n != 0 {
		t.Fatal("a rolled-back transaction must leave no event")
	}

	e := event("pi_dup", 1)
	if err := db.InTx(ctx, pool, func(tx pgx.Tx) error { _, err := w.Append(ctx, tx, e); return err }); err != nil {
		t.Fatal(err)
	}
	again := event("pi_dup", 1) // same aggregate version and type, new id
	err = db.InTx(ctx, pool, func(tx pgx.Tx) error { _, err := w.Append(ctx, tx, again); return err })
	if !errors.Is(err, outbox.ErrDuplicate) {
		t.Fatalf("duplicate fact err = %v", err)
	}
	bad := event("pi_bad", 1)
	bad.TenantID = ""
	err = db.InTx(ctx, pool, func(tx pgx.Tx) error { _, err := w.Append(ctx, tx, bad); return err })
	if !errors.Is(err, outbox.ErrInvalidEvent) {
		t.Fatalf("invalid event err = %v", err)
	}
}

func TestRelayPublishesExactBytesInOrderAndRetries(t *testing.T) {
	ctx := context.Background()
	pool := setup(t)
	clk := clock.NewFake(time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC))
	w := outbox.Writer{Schema: schema, Now: clk.Now}

	stored := map[string][]byte{}
	write := func(agg string, v int64) {
		t.Helper()
		e := event(agg, v)
		if err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
			b, err := w.Append(ctx, tx, e)
			stored[e.ID] = b
			return err
		}); err != nil {
			t.Fatal(err)
		}
		clk.Advance(time.Millisecond)
	}
	write("pi_a", 1)
	write("pi_b", 1)
	write("pi_a", 2)
	write("pi_a", 3)

	pub := &recorder{failOn: map[string]bool{"pi_b": true}}
	relay := outbox.Relay{Pool: pool, Schema: schema, Publisher: pub, Now: clk.Now}

	// Each pass publishes the next version of each healthy aggregate.
	for range 3 {
		if _, err := relay.RunOnce(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var order []string
	for _, m := range pub.got {
		if !bytes.Equal(m.Envelope, stored[m.EventID]) {
			t.Fatal("relay must deliver the exact stored bytes")
		}
		var env struct {
			AggregateID      string `json:"aggregateid"`
			AggregateVersion int64  `json:"aggregateversion"`
		}
		_ = json.Unmarshal(m.Envelope, &env)
		order = append(order, fmt.Sprintf("%s/%d", env.AggregateID, env.AggregateVersion))
	}
	if fmt.Sprint(order) != "[pi_a/1 pi_a/2 pi_a/3]" {
		t.Fatalf("published %v; want pi_a in version order, pi_b held back", order)
	}

	// pi_b failed: it waits for its backoff, then succeeds once the consumer is back.
	age, err := relay.OldestUnpublishedAge(ctx, pool)
	if err != nil || age <= 0 {
		t.Fatalf("oldest unpublished age = %v, %v", age, err)
	}
	pub.failOn = nil
	if st, _ := relay.RunOnce(ctx); st.Published != 0 {
		t.Fatal("must not retry before the backoff elapses")
	}
	clk.Advance(time.Minute)
	if st, err := relay.RunOnce(ctx); err != nil || st.Published != 1 {
		t.Fatalf("after backoff: %+v, %v", st, err)
	}
	if age, _ := relay.OldestUnpublishedAge(ctx, pool); age != 0 {
		t.Fatal("nothing should be waiting")
	}
}

func TestInboxProcessesEachEventOnce(t *testing.T) {
	ctx := context.Background()
	pool := setup(t)
	in := inbox.Inbox{Schema: schema}
	id := ids.Generator{}.NewEventID()

	handle := func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO `+schema+`.projection VALUES ($1::uuid)`, id)
		return err
	}
	deliver := func(h func(context.Context, pgx.Tx) error) (bool, error) {
		var ran bool
		err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
			var err error
			ran, err = in.Process(ctx, tx, "ledger.projector", id, "com.zoiko.pay.payment.intent.created.v1", h)
			return err
		})
		return ran, err
	}

	// A failing handler rolls back, so the event is not marked and is retried.
	boom := errors.New("projection failed")
	if _, err := deliver(func(context.Context, pgx.Tx) error { return boom }); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if ran, err := deliver(handle); err != nil || !ran {
		t.Fatalf("first successful delivery: %v, %v", ran, err)
	}
	for range 3 {
		if ran, err := deliver(handle); err != nil || ran {
			t.Fatalf("duplicate delivery ran=%v err=%v", ran, err)
		}
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM `+schema+`.projection`).Scan(&n)
	if n != 1 {
		t.Fatalf("projection rows = %d; want 1", n)
	}
}
