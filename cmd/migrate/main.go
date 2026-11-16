// Command migrate applies and checks ZoikoPay database migrations (ADR 0005).
//
//	migrate up        verify every module, then apply pending migrations
//	migrate status    show each file as applied, pending, CHANGED or MISSING FILE
//	migrate verify    parse and check files only (no database); for CI
//	migrate scaffold  print a module's platform-tables migration
//
// up and status connect with ZP_MIGRATOR_DSN (role zp_migrator). It is a
// tool, not a deployable: it never runs as a runtime role.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/migrate"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		slog.Error("migrate failed", "error", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: migrate up|status|verify|scaffold [flags]")
	}
	cmd, args := args[0], args[1:]
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	dir := fs.String("dir", "db/migrations", "migrations root (one directory per module)")
	dsnEnv := fs.String("dsn-env", "ZP_MIGRATOR_DSN", "environment variable holding the migrator DSN")
	lockWait := fs.Duration("lock-wait", time.Minute, "how long to wait for another run's lock")
	module := fs.String("module", "", "scaffold: module name")
	schema := fs.String("schema", "", "scaffold: schema (default: module)")
	writer := fs.String("writer", "", "scaffold: runtime role that owns the module, e.g. zp_execution")
	relay := fs.String("relay", "zp_relay", "scaffold: outbox relay role")
	if err := fs.Parse(args); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))

	switch cmd {
	case "verify":
		src, err := migrate.Load(os.DirFS(*dir))
		if err != nil {
			return err
		}
		n := 0
		for _, ms := range src {
			n += len(ms)
		}
		fmt.Fprintf(out, "ok: %d modules, %d migration files\n", len(src), n)
		return nil
	case "scaffold":
		if *schema == "" {
			*schema = *module
		}
		sql, err := migrate.PlatformTablesSQL(migrate.PlatformTables{Module: *module, Schema: *schema, WriterRole: *writer, RelayRole: *relay})
		if err != nil {
			return err
		}
		_, err = io.WriteString(out, sql)
		return err
	case "up", "status":
		dsn := os.Getenv(*dsnEnv)
		if dsn == "" {
			return fmt.Errorf("%s is not set", *dsnEnv)
		}
		pool, err := db.Open(ctx, dsn)
		if err != nil {
			return err
		}
		defer pool.Close()
		r := migrate.Runner{Pool: pool, Source: os.DirFS(*dir), Log: log, LockWait: *lockWait}
		if cmd == "status" {
			rows, err := r.Status(ctx)
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				fmt.Fprintln(out, "no migrations")
			}
			for _, s := range rows {
				fmt.Fprintf(out, "%-14s %-12s %6d  %s\n", s.State, s.Module, s.Version, s.Name)
			}
			return nil
		}
		applied, err := r.Up(ctx)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "applied %d migrations\n", len(applied))
		return nil
	}
	return fmt.Errorf("unknown command %q", cmd)
}
