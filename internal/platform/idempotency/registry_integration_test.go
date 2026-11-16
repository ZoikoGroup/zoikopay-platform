//go:build integration

package idempotency_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
	"github.com/zoiko/zoikopay/internal/platform/idempotency"
	"github.com/zoiko/zoikopay/internal/platform/ids"
)

const schema = "alpha"

// effectsSQL is a stand-in business table, tenant-isolated like a real one.
const effectsSQL = `-- +goose Up
CREATE TABLE alpha.effects (operation_id text PRIMARY KEY, tenant_id text NOT NULL);
ALTER TABLE alpha.effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha.effects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alpha.effects USING (tenant_id = current_setting('zp.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));
GRANT SELECT, INSERT ON alpha.effects TO zp_execution;
`

type env struct {
	pg   *dbtest.Instance
	pool *pgxpool.Pool // zp_execution
	reg  idempotency.Registry
}

func setup(t *testing.T) env {
	t.Helper()
	pg := dbtest.Start(t)
	pg.ApplyPlatformModules(t, map[string]string{schema: "zp_execution"},
		map[string]map[string]string{schema: {"00002_effects.sql": effectsSQL}})
	return env{pg: pg, pool: pg.Pool(t, "zp_execution"), reg: idempotency.Registry{Schema: schema}}
}

var tenantA = db.Tenant{Environment: "TEST", CellID: "cell_uk_01", LegalEntityID: "le_uk", TenantID: "ten_a"}

func scope(merchant string) idempotency.Scope {
	return idempotency.Scope{
		Environment: "TEST", CellID: "cell_uk_01", LegalEntityID: "le_uk", TenantID: "ten_a", MerchantID: merchant,
		ClientID: "app_1", PrincipalID: "sub_1", APIMajor: 1, Method: "POST",
		RouteTemplate: "/v1/payment_intents", OperationKind: "payment_intent.create",
	}
}

func key(t *testing.T, s string) idempotency.Key {
	t.Helper()
	k, err := idempotency.ParseHeader([]string{`"` + s + `"`})
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func fingerprint(t *testing.T, amount string) []byte {
	t.Helper()
	fp, err := idempotency.Fingerprint(idempotency.Input{OperationKind: "payment_intent.create", Method: "POST",
		Route: "/v1/payment_intents", Body: map[string]any{"amount_minor": amount, "currency": "GBP"}})
	if err != nil {
		t.Fatal(err)
	}
	return fp
}

// command is the route pattern: reserve, perform the effect only on New,
// optionally complete, all in one tenant transaction.
func (e env) command(ctx context.Context, s idempotency.Scope, k idempotency.Key, fp []byte, complete bool) (idempotency.Result, error) {
	var res idempotency.Result
	err := db.InTenantTx(ctx, e.pool, tenantA, func(tx pgx.Tx) error {
		var err error
		res, err = e.reg.Reserve(ctx, tx, s, k, fp, ids.NewPublic(ids.Operation))
		if err != nil || res.Outcome != idempotency.New {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO alpha.effects VALUES ($1, $2)`, res.OperationID, s.TenantID); err != nil {
			return err
		}
		if complete {
			return e.reg.Complete(ctx, tx, res.OperationID, 201, "pi_created")
		}
		return nil
	})
	return res, err
}

func (e env) effects(t *testing.T) int {
	t.Helper()
	var n int
	err := db.InTenantTx(context.Background(), e.pool, tenantA, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT count(*) FROM alpha.effects`).Scan(&n)
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRegistry(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	k := key(t, "8e03978e-40d5-43e8-bc93-6894a57f9324")

	first, err := e.command(ctx, scope("mer_a"), k, fingerprint(t, "1999"), true)
	if err != nil || first.Outcome != idempotency.New {
		t.Fatalf("first = %+v, %v", first, err)
	}

	t.Run("same request replays the stored result with no new effect", func(t *testing.T) {
		r, err := e.command(ctx, scope("mer_a"), k, fingerprint(t, "1999"), true)
		if err != nil || r.Outcome != idempotency.Replay || r.OperationID != first.OperationID || r.ResponseStatus != 201 || r.ResourceID != "pi_created" {
			t.Fatalf("replay = %+v, %v", r, err)
		}
		if e.effects(t) != 1 {
			t.Fatal("replay must not create a second effect")
		}
	})

	t.Run("changed payload under the same key is a mismatch with zero effects", func(t *testing.T) {
		r, err := e.command(ctx, scope("mer_a"), k, fingerprint(t, "2000"), true)
		if err != nil || r.Outcome != idempotency.Mismatch {
			t.Fatalf("mismatch = %+v, %v", r, err)
		}
		if e.effects(t) != 1 {
			t.Fatal("mismatch must not create an effect")
		}
	})

	t.Run("same key text under another merchant is a separate command", func(t *testing.T) {
		r, err := e.command(ctx, scope("mer_b"), k, fingerprint(t, "1999"), true)
		if err != nil || r.Outcome != idempotency.New || r.OperationID == first.OperationID {
			t.Fatalf("other scope = %+v, %v", r, err)
		}
	})

	t.Run("a rolled-back reservation leaves no trace", func(t *testing.T) {
		k3 := key(t, "99999999-2222-4333-8444-555555555555")
		boom := errors.New("business validation failed")
		err := db.InTenantTx(ctx, e.pool, tenantA, func(tx pgx.Tx) error {
			if _, err := e.reg.Reserve(ctx, tx, scope("mer_a"), k3, fingerprint(t, "7"), ids.NewPublic(ids.Operation)); err != nil {
				return err
			}
			return boom
		})
		if !errors.Is(err, boom) {
			t.Fatal(err)
		}
		if r, err := e.command(ctx, scope("mer_a"), k3, fingerprint(t, "7"), true); err != nil || r.Outcome != idempotency.New {
			t.Fatalf("after rollback = %+v, %v", r, err)
		}
	})

	t.Run("complete twice is refused", func(t *testing.T) {
		err := db.InTenantTx(ctx, e.pool, tenantA, func(tx pgx.Tx) error {
			return e.reg.Complete(ctx, tx, first.OperationID, 201, "pi_created")
		})
		if !errors.Is(err, idempotency.ErrNotInProgress) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("reserve refuses a transaction whose tenant differs from the scope", func(t *testing.T) {
		other := tenantA
		other.TenantID = "ten_b"
		err := db.InTenantTx(ctx, e.pool, other, func(tx pgx.Tx) error {
			_, err := e.reg.Reserve(ctx, tx, scope("mer_a"), key(t, "12345678-2222-4333-8444-555555555555"), fingerprint(t, "1"), ids.NewPublic(ids.Operation))
			return err
		})
		if !errors.Is(err, db.ErrNoTenant) {
			t.Fatalf("err = %v", err)
		}
	})
}

// Failure recovery: the process dies after the reservation committed but
// before the operation finished (04-08 §8; 02-07 inquiry-first). Retries must
// never start a second effect; they get the same operation to query.
func TestCrashAfterReserveRecoversWithoutASecondEffect(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	k := key(t, "aaaaaaaa-1111-4ccc-8ddd-eeeeeeeeeeee")
	fp := fingerprint(t, "500")

	crashed, err := e.command(ctx, scope("mer_a"), k, fp, false) // committed, never completed
	if err != nil || crashed.Outcome != idempotency.New {
		t.Fatal(crashed, err)
	}
	for range 3 { // client retries after its timeout
		r, err := e.command(ctx, scope("mer_a"), k, fp, true)
		if err != nil || r.Outcome != idempotency.InProgress || r.OperationID != crashed.OperationID {
			t.Fatalf("retry during recovery = %+v, %v", r, err)
		}
	}
	// Recovery resolves the operation and records the result.
	if err := db.InTenantTx(ctx, e.pool, tenantA, func(tx pgx.Tx) error {
		return e.reg.Complete(ctx, tx, crashed.OperationID, 201, "pi_recovered")
	}); err != nil {
		t.Fatal(err)
	}
	r, err := e.command(ctx, scope("mer_a"), k, fp, true)
	if err != nil || r.Outcome != idempotency.Replay || r.ResourceID != "pi_recovered" {
		t.Fatalf("after recovery = %+v, %v", r, err)
	}
	if e.effects(t) != 1 {
		t.Fatalf("effects = %d; want 1", e.effects(t))
	}
}

// Failure injection: the database connection dies in the middle of the
// command. Nothing may survive; the retry is a clean first attempt.
func TestConnectionKilledMidTransaction(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	super := e.pg.Pool(t, "postgres")
	k := key(t, "bbbbbbbb-1111-4ccc-8ddd-eeeeeeeeeeee")
	fp := fingerprint(t, "900")

	err := db.InTenantTx(ctx, e.pool, tenantA, func(tx pgx.Tx) error {
		r, err := e.reg.Reserve(ctx, tx, scope("mer_a"), k, fp, ids.NewPublic(ids.Operation))
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO alpha.effects VALUES ($1, 'ten_a')`, r.OperationID); err != nil {
			return err
		}
		var pid int
		if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			return err
		}
		if _, err := super.Exec(ctx, `SELECT pg_terminate_backend($1)`, pid); err != nil {
			return err
		}
		return e.reg.Complete(ctx, tx, r.OperationID, 201, "pi_x") // fails: connection gone
	})
	if err == nil {
		t.Fatal("expected the killed connection to fail the transaction")
	}
	if e.effects(t) != 0 {
		t.Fatal("a killed transaction must leave no effect")
	}
	r, err := e.command(ctx, scope("mer_a"), k, fp, true)
	if err != nil || r.Outcome != idempotency.New {
		t.Fatalf("retry after crash = %+v, %v", r, err)
	}
}

// 04-08: concurrent submissions of one key produce exactly one effect.
func TestConcurrentSameKeyProducesOneEffect(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	k := key(t, "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee")
	fp := fingerprint(t, "1999")

	const n = 25
	var wg sync.WaitGroup
	outcomes := make(chan idempotency.Outcome, n)
	for range n {
		wg.Go(func() {
			r, err := e.command(ctx, scope("mer_a"), k, fp, true)
			if err != nil {
				t.Error(err)
				return
			}
			outcomes <- r.Outcome
		})
	}
	wg.Wait()
	close(outcomes)
	news := 0
	for o := range outcomes {
		if o == idempotency.New {
			news++
		} else if o != idempotency.Replay {
			t.Errorf("unexpected outcome %v", o)
		}
	}
	if news != 1 || e.effects(t) != 1 {
		t.Fatalf("new=%d effects=%d; want exactly 1", news, e.effects(t))
	}
}
