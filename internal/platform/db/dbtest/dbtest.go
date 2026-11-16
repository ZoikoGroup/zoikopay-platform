// Package dbtest starts a throwaway PostgreSQL 18 container for integration
// tests, initialized with the same role bootstrap as Docker Compose.
//
// Only integration tests (build tag "integration") should import it.
package dbtest

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

// Image is the PostgreSQL image used by tests; keep it in sync with compose.
const Image = "postgres:18.1-alpine"

const (
	superPassword    = "test-only-super"
	migratorPassword = "test-only-migrator"
	appPassword      = "test-only-app"
	database         = "zoikopay"
)

// Instance is a running test database.
type Instance struct {
	host string
	port string
}

// Start launches PostgreSQL and registers cleanup on t.
func Start(t testing.TB) *Instance {
	t.Helper()
	ctx := context.Background()

	initScript := filepath.Join(RepoRoot(t), "deploy", "compose", "postgres", "init", "01-roles.sql")
	ctr, err := postgres.Run(ctx, Image,
		postgres.WithDatabase(database),
		postgres.WithUsername("postgres"),
		postgres.WithPassword(superPassword),
		postgres.WithInitScripts(initScript),
		testcontainers.WithEnv(map[string]string{
			"ZP_MIGRATOR_PASSWORD": migratorPassword,
			"ZP_APP_PASSWORD":      appPassword,
		}),
		postgres.BasicWaitStrategies(),
	)
	testcontainers.CleanupContainer(t, ctr)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	host, err := ctr.Host(ctx)
	if err != nil {
		t.Fatalf("container host: %v", err)
	}
	port, err := ctr.MappedPort(ctx, "5432/tcp")
	if err != nil {
		t.Fatalf("container port: %v", err)
	}
	return &Instance{host: host, port: port.Port()}
}

// DSN returns a connection string for the given role. Use "postgres" for the
// superuser, "zp_migrator" for migrations, or a runtime role such as "zp_execution".
func (i *Instance) DSN(role string) string {
	pw := appPassword
	switch role {
	case "postgres":
		pw = superPassword
	case "zp_migrator":
		pw = migratorPassword
	}
	u := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(role, pw),
		Host:     fmt.Sprintf("%s:%s", i.host, i.port),
		Path:     database,
		RawQuery: "sslmode=disable",
	}
	return u.String()
}

// RepoRoot walks up from the working directory to the directory holding go.mod.
func RepoRoot(t testing.TB) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found")
		}
		dir = parent
	}
}
