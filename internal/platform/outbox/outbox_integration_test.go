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

const schema = "alpha"

const projectionSQL = `-- +goose Up
CREATE TABLE alpha.projection (event_id uuid PRIMARY KEY, tenant_id text NOT NULL);
ALTER TABLE alpha.projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha.projection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alpha.projection USING (tenant_id = current_setting('zp.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));
GRANT SELECT, INSERT ON alpha.projection TO zp_execution;
`

type env struct {
	writer *pgxpool.Pool // zp_execution
	relay  *pgxpool.Pool // zp_relay
}

func setup(t *testing.T) env {
	t.Helper()
	pg := dbtest.Start(t)
	pg.ApplyPlatformModules(t, map[string]string{schema: "zp_execution"},
		map[string]map[string]string{schema: {"00002_projection.sql": projectionSQL}})
	return env{writer: pg.Pool(t, "zp_execution"), relay: pg.Pool(t, "zp_relay")}
}

func tenant(id string) db.Tenant {
	return db.Tenant{Environment: "TEST", CellID: "cell_uk_01", LegalEntityID: "le_1", TenantID: id}
}

func event(tenantID, agg string, version int64) outbox.Event {
	e := validEvent()
	e.ID = ids.Generator{}.NewEventID()
	e.TenantID, e.CellID, e.LegalEntityID = tenantID, "cell_uk_01", "le_1"
	e.AggregateID, e.Subject, e.AggregateVersion = agg, "payment_intent/"+agg, version
	e.Data = json.RawMessage(fmt.Sprintf(`{"payment_intent_id":%q,"v":%d}`, agg, version))
	return e
}

func (e env) append(t *testing.T, w outbox.Writer, ev outbox.Event) []byte {
	t.Helper()
	var b []byte
	if err := db.InTenantTx(context.Background(), e.writer, tenant(ev.TenantID), func(tx pgx.Tx) error {
		var err error
		b, err = w.Append(context.Background(), tx, ev)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return b
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

func (r *recorder) order(t *testing.T) string {
	t.Helper()
	var out []string
	for _, m := range r.got {
		var env struct {
			AggregateID      string `json:"aggregateid"`
			AggregateVersion int64  `json:"aggregateversion"`
		}
		if err := json.Unmarshal(m.Envelope, &env); err != nil {
			t.Fatal(err)
		}
		out = append(out, fmt.Sprintf("%s/%d", env.AggregateID, env.AggregateVersion))
	}
	return fmt.Sprint(out)
}

func TestAppendIsAtomicAndTenantScoped(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	w := outbox.Writer{Schema: schema}

	boom := errors.New("state change failed")
	err := db.InTenantTx(ctx, e.writer, tenant("ten_a"), func(tx pgx.Tx) error {
		if _, err := w.Append(ctx, tx, event("ten_a", "pi_rolled_back", 1)); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if n := countAll(t, e.relay); n != 0 {
		t.Fatal("a rolled-back transaction must leave no event")
	}

	e.append(t, w, event("ten_a", "pi_dup", 1))
	err = db.InTenantTx(ctx, e.writer, tenant("ten_a"), func(tx pgx.Tx) error {
		_, err := w.Append(ctx, tx, event("ten_a", "pi_dup", 1))
		return err
	})
	if !errors.Is(err, outbox.ErrDuplicate) {
		t.Fatalf("duplicate fact err = %v", err)
	}

	// Row-level security: an event for tenant B cannot be written in tenant A's transaction.
	err = db.InTenantTx(ctx, e.writer, tenant("ten_a"), func(tx pgx.Tx) error {
		_, err := w.Append(ctx, tx, event("ten_b", "pi_other", 1))
		return err
	})
	if err == nil {
		t.Fatal("cross-tenant append must be refused")
	}
	// And without any tenant context, nothing can be written.
	err = db.InTx(ctx, e.writer, func(tx pgx.Tx) error {
		_, err := w.Append(ctx, tx, event("ten_a", "pi_no_ctx", 1))
		return err
	})
	if err == nil {
		t.Fatal("append without tenant context must be refused")
	}
}

func countAll(t *testing.T, relay *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := relay.QueryRow(context.Background(), `SELECT count(*) FROM alpha.outbox_events`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRelayPublishesExactBytesInOrderAcrossTenants(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	clk := clock.NewFake(time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC))
	w := outbox.Writer{Schema: schema, Now: clk.Now}

	stored := map[string][]byte{}
	write := func(ten, agg string, v int64) {
		ev := event(ten, agg, v)
		stored[ev.ID] = e.append(t, w, ev)
		clk.Advance(time.Millisecond)
	}
	write("ten_a", "pi_a", 1)
	write("ten_b", "pi_b", 1)
	write("ten_a", "pi_a", 2)
	write("ten_a", "pi_a", 3)

	pub := &recorder{failOn: map[string]bool{"pi_b": true}}
	relay := outbox.Relay{Pool: e.relay, Schema: schema, Publisher: pub, Now: clk.Now}
	for range 3 {
		if _, err := relay.RunOnce(ctx); err != nil {
			t.Fatal(err)
		}
	}
	for _, m := range pub.got {
		if !bytes.Equal(m.Envelope, stored[m.EventID]) {
			t.Fatal("relay must deliver the exact stored bytes")
		}
	}
	if got := pub.order(t); got != "[pi_a/1 pi_a/2 pi_a/3]" {
		t.Fatalf("published %s; want pi_a in version order, pi_b held back", got)
	}

	// pi_b (another tenant) failed: it waits for its backoff, then succeeds.
	if age, err := relay.OldestUnpublishedAge(ctx, e.relay); err != nil || age <= 0 {
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
	if age, _ := relay.OldestUnpublishedAge(ctx, e.relay); age != 0 {
		t.Fatal("nothing should be waiting")
	}
}

func TestFailedEventsAreParkedAndRequeuedWithAudit(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	clk := clock.NewFake(time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC))
	w := outbox.Writer{Schema: schema, Now: clk.Now}
	first := event("ten_a", "pi_p", 1)
	e.append(t, w, first)
	clk.Advance(time.Millisecond)
	e.append(t, w, event("ten_a", "pi_p", 2))

	pub := &recorder{failOn: map[string]bool{"pi_p": true}}
	relay := outbox.Relay{Pool: e.relay, Schema: schema, Publisher: pub, Now: clk.Now, MaxAttempts: 3}
	parked := 0
	for range 5 {
		st, err := relay.RunOnce(ctx)
		if err != nil {
			t.Fatal(err)
		}
		parked += st.Parked
		clk.Advance(10 * time.Minute)
	}
	if parked != 1 {
		t.Fatalf("parked = %d; want 1 after 3 failures", parked)
	}
	list, err := relay.ListParked(ctx, e.relay, 10)
	if err != nil || len(list) != 1 || list[0].EventID != first.ID || list[0].Attempts != 3 || list[0].LastError == "" {
		t.Fatalf("parked list = %+v, %v", list, err)
	}

	// A parked event holds back later versions of its aggregate, and stops retrying.
	pub.failOn = nil
	if st, _ := relay.RunOnce(ctx); st.Published != 0 {
		t.Fatal("nothing may publish while version 1 is parked")
	}
	if err := relay.Requeue(ctx, first.ID, "", "x"); err == nil {
		t.Fatal("requeue without actor and reason must be refused")
	}
	if err := relay.Requeue(ctx, first.ID, "ops.agent", "consumer fixed in incident INC-42"); err != nil {
		t.Fatal(err)
	}
	if err := relay.Requeue(ctx, first.ID, "ops.agent", "consumer fixed in incident INC-42"); !errors.Is(err, outbox.ErrNotParked) {
		t.Fatalf("second requeue err = %v", err)
	}
	for range 2 {
		if _, err := relay.RunOnce(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if got := pub.order(t); got != "[pi_p/1 pi_p/2]" {
		t.Fatalf("after requeue published %s", got)
	}
	var who, why string
	var before int
	if err := e.relay.QueryRow(ctx, `SELECT requeued_by, reason, attempts_before FROM alpha.outbox_requeue_log`).Scan(&who, &why, &before); err != nil {
		t.Fatal(err)
	}
	if who != "ops.agent" || before != 3 {
		t.Fatalf("requeue log = %s %q %d", who, why, before)
	}
}

// Failure injection: the relay dies after a consumer accepted an event but
// before the relay recorded it. The event is delivered again (at least once)
// and the consumer's inbox makes the second delivery a no-op.
func TestRelayCrashRedeliversAndInboxDeduplicates(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	w := outbox.Writer{Schema: schema}
	ev := event("ten_a", "pi_crash", 1)
	e.append(t, w, ev)

	in := inbox.Inbox{Schema: schema}
	consume := func(m outbox.Message) error {
		var env outbox.Event
		if err := json.Unmarshal(m.Envelope, &env); err != nil {
			return err
		}
		return db.InTenantTx(ctx, e.writer, tenant(env.TenantID), func(tx pgx.Tx) error {
			_, err := in.Process(ctx, tx, "projector", env.ID, env.Type, func(ctx context.Context, tx pgx.Tx) error {
				_, err := tx.Exec(ctx, `INSERT INTO alpha.projection VALUES ($1::uuid, $2)`, env.ID, env.TenantID)
				return err
			})
			return err
		})
	}

	crash := publisherFunc(func(_ context.Context, m outbox.Message) error {
		if err := consume(m); err != nil {
			return err
		}
		panic("relay process killed after delivery")
	})
	func() {
		defer func() { _ = recover() }()
		_, _ = outbox.Relay{Pool: e.relay, Schema: schema, Publisher: crash}.RunOnce(ctx)
	}()

	var deliveries int
	again := publisherFunc(func(_ context.Context, m outbox.Message) error { deliveries++; return consume(m) })
	if st, err := (outbox.Relay{Pool: e.relay, Schema: schema, Publisher: again}).RunOnce(ctx); err != nil || st.Published != 1 {
		t.Fatalf("redelivery: %+v, %v", st, err)
	}
	if deliveries != 1 {
		t.Fatal("the event must be redelivered after the crash")
	}
	var n int
	_ = db.InTenantTx(ctx, e.writer, tenant("ten_a"), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM alpha.projection`).Scan(&n)
	})
	if n != 1 {
		t.Fatalf("projection rows = %d; want exactly 1 despite two deliveries", n)
	}
}

type publisherFunc func(context.Context, outbox.Message) error

func (f publisherFunc) Publish(ctx context.Context, m outbox.Message) error { return f(ctx, m) }

func TestInboxProcessesEachEventOnce(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	in := inbox.Inbox{Schema: schema}
	id := ids.Generator{}.NewEventID()

	handle := func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO alpha.projection VALUES ($1::uuid, 'ten_a')`, id)
		return err
	}
	deliver := func(ten string, h func(context.Context, pgx.Tx) error) (bool, error) {
		var ran bool
		err := db.InTenantTx(ctx, e.writer, tenant(ten), func(tx pgx.Tx) error {
			var err error
			ran, err = in.Process(ctx, tx, "ledger.projector", id, "com.zoiko.pay.payment.intent.created.v1", h)
			return err
		})
		return ran, err
	}

	boom := errors.New("projection failed")
	if _, err := deliver("ten_a", func(context.Context, pgx.Tx) error { return boom }); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if ran, err := deliver("ten_a", handle); err != nil || !ran {
		t.Fatalf("first successful delivery: %v, %v", ran, err)
	}
	for range 3 {
		if ran, err := deliver("ten_a", handle); err != nil || ran {
			t.Fatalf("duplicate delivery ran=%v err=%v", ran, err)
		}
	}
	// A replay of the same event id under another tenant is never processed.
	if ran, err := deliver("ten_b", handle); err != nil || ran {
		t.Fatalf("cross-tenant replay ran=%v err=%v", ran, err)
	}
	// Without a tenant context, processing is refused.
	err := db.InTx(ctx, e.writer, func(tx pgx.Tx) error {
		_, err := in.Process(ctx, tx, "ledger.projector", ids.Generator{}.NewEventID(), "t", handle)
		return err
	})
	if !errors.Is(err, inbox.ErrNoTenant) {
		t.Fatalf("no tenant err = %v", err)
	}
}
