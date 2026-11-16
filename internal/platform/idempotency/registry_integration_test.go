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

const schema = "m1_idem"

// setup creates the registry plus an "effects" table standing in for a
// business write, as zp_migrator, and returns a pool for runtime role zp_execution.
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
		idempotency.TableSQL(schema),
		`CREATE TABLE ` + schema + `.effects (operation_id text PRIMARY KEY)`,
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

func scope(merchant string) idempotency.Scope {
	return idempotency.Scope{
		Environment: "TEST", CellID: "cell_uk_01", LegalEntityID: "le_uk", TenantID: "ten_a", MerchantID: merchant,
		ClientID: "app_1", PrincipalID: "sub_1", APIMajor: 1, Method: "POST",
		RouteTemplate: "/v1/payment_intents", OperationKind: "payment_intent.create",
	}
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
// optionally complete, all in one transaction.
func command(ctx context.Context, pool *pgxpool.Pool, reg idempotency.Registry, s idempotency.Scope, key idempotency.Key, fp []byte, complete bool) (idempotency.Result, error) {
	var res idempotency.Result
	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		var err error
		res, err = reg.Reserve(ctx, tx, s, key, fp, ids.New(ids.Operation))
		if err != nil || res.Outcome != idempotency.New {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO `+schema+`.effects VALUES ($1)`, res.OperationID); err != nil {
			return err
		}
		if complete {
			return reg.Complete(ctx, tx, res.OperationID, 201, "pi_created")
		}
		return nil
	})
	return res, err
}

func effects(t *testing.T, pool *pgxpool.Pool) int {
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM `+schema+`.effects`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRegistry(t *testing.T) {
	ctx := context.Background()
	pool := setup(t)
	reg := idempotency.Registry{Schema: schema}
	key, _ := idempotency.ParseHeader([]string{`"8e03978e-40d5-43e8-bc93-6894a57f9324"`})

	first, err := command(ctx, pool, reg, scope("mer_a"), key, fingerprint(t, "1999"), true)
	if err != nil || first.Outcome != idempotency.New {
		t.Fatalf("first = %+v, %v", first, err)
	}

	t.Run("same request replays the stored result with no new effect", func(t *testing.T) {
		r, err := command(ctx, pool, reg, scope("mer_a"), key, fingerprint(t, "1999"), true)
		if err != nil || r.Outcome != idempotency.Replay || r.OperationID != first.OperationID || r.ResponseStatus != 201 || r.ResourceID != "pi_created" {
			t.Fatalf("replay = %+v, %v", r, err)
		}
		if effects(t, pool) != 1 {
			t.Fatal("replay must not create a second effect")
		}
	})

	t.Run("changed payload under the same key is a mismatch with zero effects", func(t *testing.T) {
		r, err := command(ctx, pool, reg, scope("mer_a"), key, fingerprint(t, "2000"), true)
		if err != nil || r.Outcome != idempotency.Mismatch {
			t.Fatalf("mismatch = %+v, %v", r, err)
		}
		if effects(t, pool) != 1 {
			t.Fatal("mismatch must not create an effect")
		}
	})

	t.Run("same key text under another merchant is a separate command", func(t *testing.T) {
		r, err := command(ctx, pool, reg, scope("mer_b"), key, fingerprint(t, "1999"), true)
		if err != nil || r.Outcome != idempotency.New || r.OperationID == first.OperationID {
			t.Fatalf("other scope = %+v, %v", r, err)
		}
	})

	t.Run("unfinished operation answers in-progress", func(t *testing.T) {
		k2, _ := idempotency.ParseHeader([]string{`"11111111-2222-4333-8444-555555555555"`})
		if r, err := command(ctx, pool, reg, scope("mer_a"), k2, fingerprint(t, "5"), false); err != nil || r.Outcome != idempotency.New {
			t.Fatalf("first = %+v, %v", r, err)
		}
		if r, err := command(ctx, pool, reg, scope("mer_a"), k2, fingerprint(t, "5"), false); err != nil || r.Outcome != idempotency.InProgress {
			t.Fatalf("retry = %+v, %v", r, err)
		}
	})

	t.Run("a rolled-back reservation leaves no trace", func(t *testing.T) {
		k3, _ := idempotency.ParseHeader([]string{`"99999999-2222-4333-8444-555555555555"`})
		boom := errors.New("business validation failed")
		err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
			if _, err := reg.Reserve(ctx, tx, scope("mer_a"), k3, fingerprint(t, "7"), ids.New(ids.Operation)); err != nil {
				return err
			}
			return boom
		})
		if !errors.Is(err, boom) {
			t.Fatal(err)
		}
		if r, err := command(ctx, pool, reg, scope("mer_a"), k3, fingerprint(t, "7"), true); err != nil || r.Outcome != idempotency.New {
			t.Fatalf("after rollback = %+v, %v", r, err)
		}
	})

	t.Run("complete twice is refused", func(t *testing.T) {
		if err := reg.Complete(ctx, pool, first.OperationID, 201, "pi_created"); !errors.Is(err, idempotency.ErrNotInProgress) {
			t.Fatalf("err = %v", err)
		}
	})
}

// 04-08 INV: concurrent submissions of one key produce exactly one effect.
func TestConcurrentSameKeyProducesOneEffect(t *testing.T) {
	ctx := context.Background()
	pool := setup(t)
	reg := idempotency.Registry{Schema: schema}
	key, _ := idempotency.ParseHeader([]string{`"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"`})
	fp := fingerprint(t, "1999")

	const n = 25
	var wg sync.WaitGroup
	outcomes := make(chan idempotency.Outcome, n)
	for range n {
		wg.Go(func() {
			r, err := command(ctx, pool, reg, scope("mer_a"), key, fp, true)
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
	if news != 1 || effects(t, pool) != 1 {
		t.Fatalf("new=%d effects=%d; want exactly 1", news, effects(t, pool))
	}
}
