//go:build integration

package migrate_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
	"github.com/zoiko/zoikopay/internal/platform/migrate"
)

type fixture struct {
	pg  *dbtest.Instance
	mig *pgxpool.Pool
	dir string
}

func setup(t *testing.T) fixture {
	t.Helper()
	pg := dbtest.Start(t)
	return fixture{pg: pg, mig: pg.Pool(t, "zp_migrator"), dir: t.TempDir()}
}

func (f fixture) write(t *testing.T, module, name, body string) {
	t.Helper()
	p := filepath.Join(f.dir, module, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (f fixture) runner() migrate.Runner {
	return migrate.Runner{Pool: f.mig, Source: os.DirFS(f.dir), LockWait: 30 * time.Second}
}

func (f fixture) history(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.mig.QueryRow(context.Background(), `SELECT count(*) FROM zp_migrations.history`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (f fixture) exists(t *testing.T, rel string) bool {
	t.Helper()
	var ok bool
	if err := f.mig.QueryRow(context.Background(), `SELECT to_regclass($1) IS NOT NULL`, rel).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

const widgetsV1 = `-- +goose Up
CREATE SCHEMA widgets;
CREATE TABLE widgets.widgets (id uuid PRIMARY KEY, amount_minor bigint NOT NULL, currency text NOT NULL);
GRANT USAGE ON SCHEMA widgets TO zp_execution;
GRANT SELECT, INSERT ON widgets.widgets TO zp_execution;
-- +goose Down
DROP SCHEMA widgets CASCADE;
`

func TestUpRecordsHistoryAndIsRepeatable(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	f.write(t, "widgets", "00001_init.sql", widgetsV1)
	f.write(t, "gadgets", "00001_init.sql", "CREATE SCHEMA gadgets;")

	applied, err := f.runner().Up(ctx)
	if err != nil || len(applied) != 2 {
		t.Fatalf("first run = %v, %v", applied, err)
	}
	if again, err := f.runner().Up(ctx); err != nil || len(again) != 0 {
		t.Fatalf("second run must apply nothing: %v, %v", again, err)
	}
	var who, runner, sum string
	if err := f.mig.QueryRow(ctx, `SELECT applied_by, runner_version, checksum_sha256 FROM zp_migrations.history WHERE module = 'widgets'`).Scan(&who, &runner, &sum); err != nil {
		t.Fatal(err)
	}
	if who != "zp_migrator" || runner != migrate.RunnerVersion || len(sum) != 64 {
		t.Fatalf("history row: %s %s %s", who, runner, sum)
	}
	if !f.exists(t, "widgets.widgets") {
		t.Fatal("the Down section ran or Up did not")
	}
}

func TestChangedAppliedFileStopsEverything(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	f.write(t, "widgets", "00001_init.sql", widgetsV1)
	if _, err := f.runner().Up(ctx); err != nil {
		t.Fatal(err)
	}
	// Someone edits an applied file, and another module has a pending file.
	f.write(t, "widgets", "00001_init.sql", widgetsV1+"\n-- harmless looking edit\n")
	f.write(t, "gadgets", "00001_init.sql", "CREATE SCHEMA gadgets;")
	if _, err := f.runner().Up(ctx); !errors.Is(err, migrate.ErrChecksumMismatch) {
		t.Fatalf("err = %v; want ErrChecksumMismatch", err)
	}
	var gadgets bool
	if err := f.mig.QueryRow(ctx, `SELECT to_regnamespace('gadgets') IS NOT NULL`).Scan(&gadgets); err != nil {
		t.Fatal(err)
	}
	if gadgets || f.history(t) != 1 {
		t.Fatal("nothing may be applied when any applied file changed")
	}
	st, err := f.runner().Status(ctx)
	if err != nil || st[len(st)-1].State != migrate.StateChanged {
		t.Fatalf("status = %+v, %v", st, err)
	}
	// Deleting an applied file is caught the same way.
	if err := os.Remove(filepath.Join(f.dir, "widgets", "00001_init.sql")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.runner().Up(ctx); !errors.Is(err, migrate.ErrMissingFile) {
		t.Fatalf("missing file err = %v", err)
	}
}

func TestFailedMigrationRollsBackCompletely(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	f.write(t, "widgets", "00001_init.sql", `CREATE SCHEMA widgets; CREATE TABLE widgets.half (id int); SELECT 1/0;`)
	if _, err := f.runner().Up(ctx); err == nil {
		t.Fatal("division by zero must fail the migration")
	}
	if f.exists(t, "widgets.half") || f.history(t) != 0 {
		t.Fatal("a failed migration must leave no table and no history row")
	}
	f.write(t, "widgets", "00001_init.sql", widgetsV1) // fixed before it was ever applied
	if applied, err := f.runner().Up(ctx); err != nil || len(applied) != 1 {
		t.Fatalf("after fix: %v, %v", applied, err)
	}
}

func TestOutOfOrderPendingFileIsRefused(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	f.write(t, "widgets", "00001_init.sql", widgetsV1)
	f.write(t, "widgets", "00003_c.sql", "CREATE TABLE widgets.c (id int);")
	if _, err := f.runner().Up(ctx); err != nil {
		t.Fatal(err)
	}
	f.write(t, "widgets", "00002_b.sql", "CREATE TABLE widgets.b (id int);") // merged late
	if _, err := f.runner().Up(ctx); !errors.Is(err, migrate.ErrOutOfOrder) {
		t.Fatalf("err = %v; want ErrOutOfOrder", err)
	}
}

func TestConcurrentRunnersApplyEachMigrationOnce(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	f.write(t, "widgets", "00001_init.sql", widgetsV1)
	f.write(t, "widgets", "00002_slow.sql", "SELECT pg_sleep(0.5); CREATE TABLE widgets.slow (id int);")
	f.write(t, "gadgets", "00001_init.sql", "CREATE SCHEMA gadgets;")

	var wg sync.WaitGroup
	total := make(chan int, 5)
	for range 5 {
		wg.Go(func() {
			applied, err := f.runner().Up(ctx)
			if err != nil {
				t.Error(err)
				return
			}
			total <- len(applied)
		})
	}
	wg.Wait()
	close(total)
	sum := 0
	for n := range total {
		sum += n
	}
	if sum != 3 || f.history(t) != 3 {
		t.Fatalf("applied %d (history %d); want each of 3 migrations exactly once", sum, f.history(t))
	}
}

func TestLockTimeoutWhenAnotherRunHoldsTheLock(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	f.write(t, "widgets", "00001_init.sql", widgetsV1)
	holder, err := f.mig.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_lock(x'5a504d494752'::bigint)`); err != nil {
		t.Fatal(err)
	}
	r := f.runner()
	r.LockWait = 500 * time.Millisecond
	if _, err := r.Up(ctx); !errors.Is(err, migrate.ErrLockTimeout) {
		t.Fatalf("err = %v; want ErrLockTimeout", err)
	}
	if f.exists(t, "widgets.widgets") {
		t.Fatal("nothing may run without the lock")
	}
}

func TestHistoryIsAppendOnlyAndHiddenFromRuntimeRoles(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	f.write(t, "widgets", "00001_init.sql", widgetsV1)
	if _, err := f.runner().Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`UPDATE zp_migrations.history SET checksum_sha256 = repeat('0', 64)`,
		`DELETE FROM zp_migrations.history`,
		`TRUNCATE zp_migrations.history`,
	} {
		if _, err := f.mig.Exec(ctx, stmt); sqlState(err) != "23001" {
			t.Errorf("%s as migrator: %v; want restrict_violation", stmt, err)
		}
	}
	rt := f.pg.Pool(t, "zp_execution")
	if _, err := rt.Exec(ctx, `SELECT 1 FROM zp_migrations.history`); sqlState(err) != "42501" {
		t.Fatalf("runtime role read history: %v; want insufficient_privilege", err)
	}
}

// Expand–migrate–contract against existing data: version 2 adds a column
// (expand) while version-1 code keeps writing without it; existing rows are
// untouched; the contract step needs its annotation.
func TestExpandIsCompatibleWithTheRunningVersionAndExistingData(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	f.write(t, "widgets", "00001_init.sql", widgetsV1)
	if _, err := f.runner().Up(ctx); err != nil {
		t.Fatal(err)
	}
	app := f.pg.Pool(t, "zp_execution")
	v1Insert := `INSERT INTO widgets.widgets (id, amount_minor, currency) VALUES (uuidv7(), $1, 'GBP')`
	if _, err := app.Exec(ctx, v1Insert, int64(1999)); err != nil {
		t.Fatal(err)
	}

	f.write(t, "widgets", "00002_expand_note.sql", `ALTER TABLE widgets.widgets ADD COLUMN note text NULL;`)
	if _, err := f.runner().Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := app.Exec(ctx, v1Insert, int64(5)); err != nil {
		t.Fatalf("version-1 code broke after the expand step: %v", err)
	}
	var n int
	var total int64
	if err := app.QueryRow(ctx, `SELECT count(*), sum(amount_minor) FROM widgets.widgets WHERE note IS NULL`).Scan(&n, &total); err != nil {
		t.Fatal(err)
	}
	if n != 2 || total != 2004 {
		t.Fatalf("existing data changed: %d rows, total %d", n, total)
	}

	f.write(t, "widgets", "00003_contract.sql", `ALTER TABLE widgets.widgets DROP COLUMN note;`)
	if _, err := f.runner().Up(ctx); !errors.Is(err, migrate.ErrInvalidSource) || !strings.Contains(err.Error(), "zp:contract") {
		t.Fatalf("unannotated contract err = %v", err)
	}
}

func TestNonTransactionalMigration(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	f.write(t, "widgets", "00001_init.sql", widgetsV1)
	f.write(t, "widgets", "00002_index.sql", "-- +goose NO TRANSACTION\n-- +goose Up\nCREATE INDEX CONCURRENTLY IF NOT EXISTS widgets_currency ON widgets.widgets (currency);\n")
	if _, err := f.runner().Up(ctx); err != nil {
		t.Fatal(err)
	}
	if !f.exists(t, "widgets.widgets_currency") {
		t.Fatal("concurrent index not created")
	}
}

func sqlState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}
