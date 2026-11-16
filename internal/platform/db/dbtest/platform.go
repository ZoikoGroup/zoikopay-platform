package dbtest

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/migrate"
)

// Pool opens a pool for role and closes it when the test ends.
func (i *Instance) Pool(t testing.TB, role string) *pgxpool.Pool {
	t.Helper()
	p, err := db.Open(context.Background(), i.DSN(role))
	if err != nil {
		t.Fatalf("open %s: %v", role, err)
	}
	t.Cleanup(p.Close)
	return p
}

// ApplyPlatformModules scaffolds each module's platform-tables migration
// (schema = module name, writer role as given, relay zp_relay) into a fresh
// directory and applies it through the real migration runner as
// zp_migrator, exactly as a module would in production. extra maps a module
// to further migration files (name → SQL) applied after the platform tables.
func (i *Instance) ApplyPlatformModules(t testing.TB, writers map[string]string, extra map[string]map[string]string) {
	t.Helper()
	dir := t.TempDir()
	for module, writer := range writers {
		sql, err := migrate.PlatformTablesSQL(migrate.PlatformTables{Module: module, Schema: module, WriterRole: writer, RelayRole: "zp_relay"})
		if err != nil {
			t.Fatal(err)
		}
		write(t, filepath.Join(dir, module, "00001_platform_tables.sql"), sql)
		for name, body := range extra[module] {
			write(t, filepath.Join(dir, module, name), body)
		}
	}
	r := migrate.Runner{Pool: i.Pool(t, "zp_migrator"), Source: os.DirFS(dir)}
	if _, err := r.Up(context.Background()); err != nil {
		t.Fatalf("apply platform modules: %v", err)
	}
}

func write(t testing.TB, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}
