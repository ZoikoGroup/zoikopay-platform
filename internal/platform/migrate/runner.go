package migrate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/platform/db"
)

// RunnerVersion is recorded with every applied migration.
const RunnerVersion = "zp-migrate/1"

// lockKey is the advisory lock every migration run takes ("ZPMIGR").
const lockKey int64 = 0x5a504d494752

// Errors that stop a run before anything is applied.
var (
	ErrChecksumMismatch = errors.New("an applied migration file has changed")
	ErrMissingFile      = errors.New("an applied migration file is missing")
	ErrOutOfOrder       = errors.New("a pending migration is older than an applied one")
	ErrLockTimeout      = errors.New("another migration run holds the lock")
)

// Runner applies migrations. Pool must log in as zp_migrator.
type Runner struct {
	Pool        *pgxpool.Pool
	Source      fs.FS            // db/migrations
	Log         *slog.Logger     // optional
	LockWait    time.Duration    // how long to wait for another run; default 60s
	LockTimeout time.Duration    // per-migration lock_timeout; default 10s
	StmtTimeout time.Duration    // per-migration statement_timeout; default 10m
	Now         func() time.Time // defaults to time.Now
}

// Applied is one migration applied by this run.
type Applied struct {
	Module   string
	Version  int64
	Name     string
	Duration time.Duration
}

type historyRow struct {
	name     string
	checksum string
}

func (r Runner) log() *slog.Logger {
	if r.Log != nil {
		return r.Log
	}
	return slog.New(slog.DiscardHandler)
}

func (r Runner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

// Up verifies every module, then applies pending migrations module by module
// in version order. Verification covers all modules before the first change:
// a changed, missing or out-of-order file anywhere means nothing is applied.
func (r Runner) Up(ctx context.Context) ([]Applied, error) {
	src, err := Load(r.Source)
	if err != nil {
		return nil, err
	}
	conn, err := r.lock(ctx)
	if err != nil {
		return nil, err
	}
	defer r.unlock(conn)

	if err := ensureHistory(ctx, conn.Conn()); err != nil {
		return nil, err
	}
	history, err := readHistory(ctx, conn.Conn())
	if err != nil {
		return nil, err
	}
	pending, err := plan(src, history)
	if err != nil {
		return nil, err
	}

	var done []Applied
	for _, m := range pending {
		start := time.Now()
		if err := r.apply(ctx, conn.Conn(), m); err != nil {
			return done, fmt.Errorf("apply %s/%s: %w", m.Module, m.Name, err)
		}
		a := Applied{Module: m.Module, Version: m.Version, Name: m.Name, Duration: time.Since(start)}
		r.log().Info("migration applied", "module", m.Module, "file", m.Name, "ms", a.Duration.Milliseconds())
		done = append(done, a)
	}
	return done, nil
}

// plan checks integrity against history and returns pending migrations.
func plan(src map[string][]Migration, history map[string]map[int64]historyRow) ([]Migration, error) {
	var problems []string
	var pending []Migration
	modules := make([]string, 0, len(src)+len(history))
	for m := range src {
		modules = append(modules, m)
	}
	for m := range history {
		if _, ok := src[m]; !ok {
			modules = append(modules, m)
		}
	}
	sort.Strings(modules)
	var kinds []error
	for _, mod := range modules {
		applied := history[mod]
		files := map[int64]Migration{}
		var maxApplied int64
		for _, m := range src[mod] {
			files[m.Version] = m
		}
		for v, h := range applied {
			maxApplied = max(maxApplied, v)
			f, ok := files[v]
			switch {
			case !ok:
				problems = append(problems, fmt.Sprintf("%s: applied version %d (%s) has no file", mod, v, h.name))
				kinds = append(kinds, ErrMissingFile)
			case f.Checksum != h.checksum:
				problems = append(problems, fmt.Sprintf("%s/%s: checksum %s… differs from applied %s…", mod, f.Name, f.Checksum[:12], h.checksum[:12]))
				kinds = append(kinds, ErrChecksumMismatch)
			}
		}
		for _, m := range src[mod] {
			if _, done := applied[m.Version]; done {
				continue
			}
			if m.Version < maxApplied {
				problems = append(problems, fmt.Sprintf("%s/%s: version %d is pending but %d is already applied", mod, m.Name, m.Version, maxApplied))
				kinds = append(kinds, ErrOutOfOrder)
				continue
			}
			pending = append(pending, m)
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return nil, fmt.Errorf("%w: nothing applied:\n  %s", errors.Join(dedupe(kinds)...), strings.Join(problems, "\n  "))
	}
	return pending, nil
}

func dedupe(errs []error) []error {
	var out []error
	seen := map[error]bool{}
	for _, e := range errs {
		if !seen[e] {
			seen[e] = true
			out = append(out, e)
		}
	}
	return out
}

func (r Runner) apply(ctx context.Context, conn *pgx.Conn, m Migration) error {
	lockTimeout, stmtTimeout := r.LockTimeout, r.StmtTimeout
	if lockTimeout <= 0 {
		lockTimeout = 10 * time.Second
	}
	if stmtTimeout <= 0 {
		stmtTimeout = 10 * time.Minute
	}
	start := time.Now()
	if !m.Transactional {
		// For statements PostgreSQL refuses inside a transaction (e.g. CREATE
		// INDEX CONCURRENTLY). They must be idempotent (IF NOT EXISTS): if the
		// history insert fails, a rerun repeats them.
		if _, err := conn.Exec(ctx, fmt.Sprintf("SET lock_timeout = '%dms'; SET statement_timeout = '%dms'",
			lockTimeout.Milliseconds(), stmtTimeout.Milliseconds())); err != nil {
			return err
		}
		defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), "RESET lock_timeout; RESET statement_timeout") }()
		if _, err := conn.Exec(ctx, m.Up); err != nil {
			return err
		}
		_, err := conn.Exec(ctx, `INSERT INTO zp_migrations.history
			(module, version, name, checksum_sha256, transactional, applied_at_utc, execution_ms, runner_version)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, m.Module, m.Version, m.Name, m.Checksum, false, r.now(), time.Since(start).Milliseconds(), RunnerVersion)
		return err
	}
	return pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, fmt.Sprintf("SET LOCAL lock_timeout = '%dms'; SET LOCAL statement_timeout = '%dms'",
			lockTimeout.Milliseconds(), stmtTimeout.Milliseconds())); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, m.Up); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO zp_migrations.history
			(module, version, name, checksum_sha256, transactional, applied_at_utc, execution_ms, runner_version)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, m.Module, m.Version, m.Name, m.Checksum, true, r.now(), time.Since(start).Milliseconds(), RunnerVersion)
		return err
	})
}

func (r Runner) lock(ctx context.Context) (*pgxpool.Conn, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire migration connection: %w", err)
	}
	wait := r.LockWait
	if wait <= 0 {
		wait = 60 * time.Second
	}
	deadline := time.Now().Add(wait)
	for {
		var ok bool
		if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, lockKey).Scan(&ok); err != nil {
			conn.Release()
			return nil, fmt.Errorf("take migration lock: %w", err)
		}
		if ok {
			return conn, nil
		}
		if time.Now().After(deadline) {
			conn.Release()
			return nil, fmt.Errorf("%w (waited %s)", ErrLockTimeout, wait)
		}
		r.log().Info("waiting for the migration lock")
		select {
		case <-ctx.Done():
			conn.Release()
			return nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func (r Runner) unlock(conn *pgxpool.Conn) {
	if _, err := conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, lockKey); err != nil {
		// The session lock dies with the connection; destroy it to be sure.
		_ = conn.Conn().Close(context.Background())
	}
	conn.Release()
}

// HistorySQL creates the append-only history table (idempotent).
const HistorySQL = `
CREATE TABLE IF NOT EXISTS zp_migrations.history (
    module          text        NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]*$'),
    version         bigint      NOT NULL CHECK (version > 0),
    name            text        NOT NULL,
    checksum_sha256 text        NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    transactional   boolean     NOT NULL,
    applied_at_utc  timestamptz NOT NULL,
    applied_by      text        NOT NULL DEFAULT current_user,
    execution_ms    bigint      NOT NULL CHECK (execution_ms >= 0),
    runner_version  text        NOT NULL,
    PRIMARY KEY (module, version)
);
CREATE OR REPLACE FUNCTION zp_migrations.history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'migration history is append-only' USING ERRCODE = 'restrict_violation';
END $$;
CREATE OR REPLACE TRIGGER history_guard BEFORE UPDATE OR DELETE ON zp_migrations.history
    FOR EACH ROW EXECUTE FUNCTION zp_migrations.history_guard();
CREATE OR REPLACE TRIGGER history_guard_truncate BEFORE TRUNCATE ON zp_migrations.history
    FOR EACH STATEMENT EXECUTE FUNCTION zp_migrations.history_guard();`

func ensureHistory(ctx context.Context, conn *pgx.Conn) error {
	if _, err := conn.Exec(ctx, HistorySQL); err != nil {
		return fmt.Errorf("create migration history: %w", err)
	}
	return nil
}

func readHistory(ctx context.Context, q db.DBTX) (map[string]map[int64]historyRow, error) {
	rows, err := q.Query(ctx, `SELECT module, version, name, checksum_sha256 FROM zp_migrations.history`)
	if err != nil {
		return nil, fmt.Errorf("read migration history: %w", err)
	}
	defer rows.Close()
	out := map[string]map[int64]historyRow{}
	for rows.Next() {
		var mod string
		var v int64
		var h historyRow
		if err := rows.Scan(&mod, &v, &h.name, &h.checksum); err != nil {
			return nil, fmt.Errorf("scan migration history: %w", err)
		}
		if out[mod] == nil {
			out[mod] = map[int64]historyRow{}
		}
		out[mod][v] = h
	}
	return out, rows.Err()
}

// State of one file in Status.
type State string

// File states reported by Status.
const (
	StatePending State = "pending"
	StateApplied State = "applied"
	StateChanged State = "CHANGED"
	StateMissing State = "MISSING FILE"
)

// FileStatus is one row of Status.
type FileStatus struct {
	Module  string
	Version int64
	Name    string
	State   State
}

// Status compares files with history without taking the lock or changing anything.
func (r Runner) Status(ctx context.Context) ([]FileStatus, error) {
	src, err := Load(r.Source)
	if err != nil {
		return nil, err
	}
	var exists bool
	if err := r.Pool.QueryRow(ctx, `SELECT to_regclass('zp_migrations.history') IS NOT NULL`).Scan(&exists); err != nil {
		return nil, fmt.Errorf("check migration history: %w", err)
	}
	history := map[string]map[int64]historyRow{}
	if exists {
		if history, err = readHistory(ctx, r.Pool); err != nil {
			return nil, err
		}
	}
	var out []FileStatus
	for mod, ms := range src {
		for _, m := range ms {
			st := StatePending
			if h, ok := history[mod][m.Version]; ok {
				st = StateApplied
				if h.checksum != m.Checksum {
					st = StateChanged
				}
			}
			out = append(out, FileStatus{Module: mod, Version: m.Version, Name: m.Name, State: st})
		}
	}
	for mod, hs := range history {
		for v, h := range hs {
			found := false
			for _, m := range src[mod] {
				found = found || m.Version == v
			}
			if !found {
				out = append(out, FileStatus{Module: mod, Version: v, Name: h.name, State: StateMissing})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Module != out[j].Module {
			return out[i].Module < out[j].Module
		}
		return out[i].Version < out[j].Version
	})
	return out, nil
}
