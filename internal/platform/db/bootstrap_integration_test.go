//go:build integration

package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
	"github.com/zoiko/zoikopay/internal/platform/health"
)

var runtimeRoles = []string{"zp_gateway", "zp_execution", "zp_finance", "zp_governance", "zp_relay"}

// TestBootstrapRoleModel proves the preconditions rule 8 depends on: runtime
// roles cannot bypass RLS, are not superusers and cannot run DDL.
func TestBootstrapRoleModel(t *testing.T) {
	pg := dbtest.Start(t)
	ctx := context.Background()

	super, err := db.Open(ctx, pg.DSN("postgres"))
	if err != nil {
		t.Fatal(err)
	}
	defer super.Close()

	t.Run("server is PostgreSQL 18 with native uuidv7", func(t *testing.T) {
		var version int
		if err := super.QueryRow(ctx, "SELECT current_setting('server_version_num')::int").Scan(&version); err != nil {
			t.Fatal(err)
		}
		if version < 180000 {
			t.Fatalf("server_version_num = %d, want >= 180000", version)
		}
		var v int
		if err := super.QueryRow(ctx, "SELECT uuid_extract_version(uuidv7())").Scan(&v); err != nil {
			t.Fatal(err)
		}
		if v != 7 {
			t.Fatalf("uuidv7() produced version %d", v)
		}
	})

	for _, role := range append([]string{"zp_migrator"}, runtimeRoles...) {
		t.Run("role attributes/"+role, func(t *testing.T) {
			var isSuper, bypassRLS, createRole, createDB bool
			err := super.QueryRow(ctx,
				`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1`,
				role).Scan(&isSuper, &bypassRLS, &createRole, &createDB)
			if err != nil {
				t.Fatalf("lookup %s: %v", role, err)
			}
			if isSuper || bypassRLS || createRole || createDB {
				t.Fatalf("%s: superuser=%v bypassrls=%v createrole=%v createdb=%v; all must be false",
					role, isSuper, bypassRLS, createRole, createDB)
			}
		})
	}

	for _, role := range runtimeRoles {
		t.Run("runtime role cannot run DDL/"+role, func(t *testing.T) {
			pool, err := db.Open(ctx, pg.DSN(role))
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			for _, stmt := range []string{
				"CREATE SCHEMA forbidden",
				"CREATE TABLE public.forbidden (id int)",
			} {
				_, err := pool.Exec(ctx, stmt)
				assertInsufficientPrivilege(t, stmt, err)
			}
		})
	}

	t.Run("migrator can create schemas", func(t *testing.T) {
		pool, err := db.Open(ctx, pg.DSN("zp_migrator"))
		if err != nil {
			t.Fatal(err)
		}
		defer pool.Close()
		if _, err := pool.Exec(ctx, "CREATE SCHEMA m0_probe"); err != nil {
			t.Fatalf("migrator CREATE SCHEMA: %v", err)
		}
	})

	t.Run("Dependency connects as a runtime role and probes", func(t *testing.T) {
		t.Setenv("ZP_DATABASE_URL", pg.DSN("zp_gateway"))
		probe, closeFn, err := db.Dependency("ZP_DATABASE_URL", nil).Open(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer closeFn()
		if err := probe(ctx); err != nil {
			t.Fatalf("probe: %v", err)
		}
	})

	t.Run("Dependency fails fast without configuration", func(t *testing.T) {
		t.Setenv("ZP_DATABASE_URL", "")
		_, _, err := db.Dependency("ZP_DATABASE_URL", nil).Open(ctx)
		if !errors.Is(err, health.ErrConfig) {
			t.Fatalf("got %v, want health.ErrConfig", err)
		}
	})

	t.Run("database timezone is UTC", func(t *testing.T) {
		pool, err := db.Open(ctx, pg.DSN("zp_execution"))
		if err != nil {
			t.Fatal(err)
		}
		defer pool.Close()
		var tz string
		if err := pool.QueryRow(ctx, "SHOW timezone").Scan(&tz); err != nil {
			t.Fatal(err)
		}
		if tz != "UTC" {
			t.Fatalf("timezone = %q, want UTC", tz)
		}
	})
}

func assertInsufficientPrivilege(t *testing.T, stmt string, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("%q: got %v, want SQLSTATE 42501 insufficient_privilege", stmt, err)
	}
}
