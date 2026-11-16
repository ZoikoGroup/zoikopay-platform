//go:build integration

package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
	"github.com/zoiko/zoikopay/internal/platform/ids"
	"github.com/zoiko/zoikopay/internal/platform/money"
)

// Two modules owned by different deployables (alpha → zp_execution,
// beta → zp_finance), built from the scaffolded platform migration.
func TestDatabaseSecurity(t *testing.T) {
	ctx := context.Background()
	pg := dbtest.Start(t)

	// A table using the platform's ID and money constraint helpers.
	ledgerish := "-- +goose Up\nCREATE TABLE alpha.charges (\n" +
		"  id uuid PRIMARY KEY " + ids.InternalIDCheckSQL("id") + ",\n" +
		"  public_id text NOT NULL UNIQUE " + ids.PublicIDCheckSQL("public_id", ids.PaymentIntent) + ",\n" +
		"  tenant_id text NOT NULL,\n" +
		"  amount_minor bigint NOT NULL " + money.TransactionAmountCheckSQL("amount_minor") + ",\n" +
		"  currency text NOT NULL " + money.CurrencyCheckSQL("currency") + "\n);\n" +
		db.TenantRLSSQL("alpha", "charges") + "\nGRANT SELECT, INSERT ON alpha.charges TO zp_execution;\n"

	pg.ApplyPlatformModules(t,
		map[string]string{"alpha": "zp_execution", "beta": "zp_finance"},
		map[string]map[string]string{"alpha": {"00002_charges.sql": ledgerish}})

	exec := pg.Pool(t, "zp_execution")
	fin := pg.Pool(t, "zp_finance")
	relay := pg.Pool(t, "zp_relay")
	mig := pg.Pool(t, "zp_migrator")
	tA := db.Tenant{Environment: "TEST", CellID: "cell_uk_01", LegalEntityID: "le_1", TenantID: "ten_a"}
	tB := tA
	tB.TenantID = "ten_b"

	insertCharge := func(ten db.Tenant, tenantCol, publicID string, amount int64, currency string) error {
		return db.InTenantTx(ctx, exec, ten, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO alpha.charges VALUES ($1::uuid, $2, $3, $4, $5)`,
				ids.NewInternal(), publicID, tenantCol, amount, currency)
			return err
		})
	}

	t.Run("module roles cannot touch another module's schema", func(t *testing.T) {
		for _, stmt := range []string{
			`SELECT 1 FROM alpha.idempotency_registry`,
			`SELECT 1 FROM alpha.outbox_events`,
			`INSERT INTO alpha.event_inbox VALUES ('c', uuidv7(), 't', 'ten_a', now())`,
		} {
			if _, err := fin.Exec(ctx, stmt); state(err) != "42501" {
				t.Errorf("zp_finance %q: %v; want insufficient_privilege", stmt, err)
			}
		}
		if _, err := exec.Exec(ctx, `SELECT 1 FROM beta.outbox_events`); state(err) != "42501" {
			t.Errorf("zp_execution read beta: want insufficient_privilege")
		}
	})

	t.Run("runtime roles cannot delete, truncate, rewrite events or run DDL", func(t *testing.T) {
		for _, stmt := range []string{
			`DELETE FROM alpha.idempotency_registry`,
			`TRUNCATE alpha.idempotency_registry`,
			`UPDATE alpha.idempotency_registry SET key_digest = key_digest`,
			`UPDATE alpha.outbox_events SET envelope = envelope`,
			`DELETE FROM alpha.event_inbox`,
			`CREATE TABLE alpha.sneaky (id int)`,
			`ALTER TABLE alpha.charges DISABLE ROW LEVEL SECURITY`,
			`SELECT 1 FROM zp_migrations.history`,
		} {
			if _, err := exec.Exec(ctx, stmt); state(err) != "42501" {
				t.Errorf("zp_execution %q: %v; want insufficient_privilege", stmt, err)
			}
		}
		// The relay may change delivery state only, never the event bytes, and
		// has no access to the idempotency registry.
		if _, err := relay.Exec(ctx, `UPDATE alpha.outbox_events SET envelope = envelope`); state(err) != "42501" {
			t.Errorf("relay rewrote envelope: %v", err)
		}
		if _, err := relay.Exec(ctx, `SELECT 1 FROM alpha.idempotency_registry`); state(err) != "42501" {
			t.Errorf("relay read idempotency registry: %v", err)
		}
	})

	t.Run("guards stop even the table owner", func(t *testing.T) {
		// Put one row in, then try to destroy it as zp_migrator (the owner).
		if err := db.InTenantTx(ctx, exec, tA, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO alpha.idempotency_registry VALUES ('TEST','cell_uk_01','le_1','ten_a','mer_1','app','sub',1,'POST','/r','k',
				sha256('k'),'zp-fp-v1',sha256('f'),'op_1','IN_PROGRESS',NULL,NULL,now(),now())`)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		err := db.InTenantTx(ctx, mig, tA, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `DELETE FROM alpha.idempotency_registry`)
			return err
		})
		if state(err) != "23001" {
			t.Errorf("owner delete: %v; want restrict_violation", err)
		}
		if _, err := mig.Exec(ctx, `TRUNCATE alpha.idempotency_registry`); state(err) != "23001" {
			t.Errorf("owner truncate: %v; want restrict_violation", err)
		}
		err = db.InTenantTx(ctx, mig, tA, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE alpha.idempotency_registry SET request_fingerprint = sha256('other')`)
			return err
		})
		if state(err) != "23001" {
			t.Errorf("owner changed fingerprint: %v; want restrict_violation", err)
		}
	})

	t.Run("row-level security isolates tenants and fails closed", func(t *testing.T) {
		if err := insertCharge(tA, "ten_a", ids.NewPublic(ids.PaymentIntent), 1999, "GBP"); err != nil {
			t.Fatal(err)
		}
		see := func(ten *db.Tenant) int {
			var n int
			fn := func(tx pgx.Tx) error { return tx.QueryRow(ctx, `SELECT count(*) FROM alpha.charges`).Scan(&n) }
			var err error
			if ten == nil {
				err = db.InTx(ctx, exec, fn)
			} else {
				err = db.InTenantTx(ctx, exec, *ten, fn)
			}
			if err != nil {
				t.Fatal(err)
			}
			return n
		}
		if see(&tA) != 1 || see(&tB) != 0 || see(nil) != 0 {
			t.Fatalf("visible rows: A=%d B=%d none=%d; want 1 0 0", see(&tA), see(&tB), see(nil))
		}
		if err := insertCharge(tB, "ten_a", ids.NewPublic(ids.PaymentIntent), 1, "GBP"); state(err) != "42501" {
			t.Fatalf("tenant B wrote a tenant A row: %v", err)
		}
		// Settings are transaction-local: a pooled connection does not keep them.
		var leaked *string
		if err := exec.QueryRow(ctx, `SELECT current_setting('zp.tenant_id', true)`).Scan(&leaked); err != nil {
			t.Fatal(err)
		}
		if leaked != nil && *leaked != "" {
			t.Fatalf("tenant context leaked outside its transaction: %q", *leaked)
		}
	})

	t.Run("database enforces ID formats, uniqueness and money constraints", func(t *testing.T) {
		pub := ids.NewPublic(ids.PaymentIntent)
		if err := insertCharge(tA, "ten_a", pub, 1, "GBP"); err != nil {
			t.Fatal(err)
		}
		cases := map[string]error{
			"duplicate public id": insertCharge(tA, "ten_a", pub, 1, "GBP"),
			"wrong prefix":        insertCharge(tA, "ten_a", ids.NewPublic(ids.Refund), 1, "GBP"),
			"not uuidv7 suffix":   insertCharge(tA, "ten_a", "pi_00000000000040008000000000000000", 1, "GBP"),
			"over 15 digits":      insertCharge(tA, "ten_a", ids.NewPublic(ids.PaymentIntent), money.MaxTransactionMinor+1, "GBP"),
			"unknown currency":    insertCharge(tA, "ten_a", ids.NewPublic(ids.PaymentIntent), 1, "XXX"),
		}
		for name, err := range cases {
			if s := state(err); s != "23505" && s != "23514" {
				t.Errorf("%s: %v; want a unique or check violation", name, err)
			}
		}
		err := db.InTenantTx(ctx, exec, tA, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO alpha.charges VALUES (gen_random_uuid(), $1, 'ten_a', 1, 'GBP')`, ids.NewPublic(ids.PaymentIntent))
			return err
		})
		if state(err) != "23514" {
			t.Errorf("UUIDv4 primary key accepted: %v", err)
		}
	})
}

func state(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	if err != nil {
		return "error"
	}
	return ""
}
