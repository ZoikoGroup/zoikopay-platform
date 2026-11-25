//go:build integration

package store_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
	"github.com/zoiko/zoikopay/internal/platform/ids"
	"github.com/zoiko/zoikopay/internal/platform/migrate"
)

// SQLSTATE codes the tests expect.
const (
	insufficientPrivilege = "42501" // missing grant, or a row-level security WITH CHECK failure
	restrictViolation     = "23001" // raised by the merchant guards
	checkViolation        = "23514"
	foreignKeyViolation   = "23503"
	uniqueViolation       = "23505"
)

var t0 = time.Date(2026, 11, 25, 9, 0, 0, 0, time.UTC)

type fixture struct {
	ctx context.Context
	pg  *dbtest.Instance
	gw  *pgxpool.Pool // zp_gateway: BC-01's runtime role (deployable D1)
	mig *pgxpool.Pool // zp_migrator: owns the schema
}

// setup applies the real db/migrations through the approved runner, exactly
// as `make migrate` does, then connects as BC-01's runtime role and the owner.
func setup(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	pg := dbtest.Start(t)
	r := migrate.Runner{Pool: pg.Pool(t, "zp_migrator"), Source: os.DirFS(filepath.Join(dbtest.RepoRoot(t), "db", "migrations"))}
	if _, err := r.Up(ctx); err != nil {
		t.Fatalf("apply real migrations: %v", err)
	}
	return &fixture{ctx: ctx, pg: pg, gw: pg.Pool(t, "zp_gateway"), mig: pg.Pool(t, "zp_migrator")}
}

// scope is a full tenant context for db.InTenantTx. Cell and legal entity are
// placeholders: the merchant tables isolate by tenant only.
func scope(tenantID string) db.Tenant {
	return db.Tenant{Environment: "TEST", CellID: "cell_uk_01", LegalEntityID: "le_uk_01", TenantID: tenantID}
}

// access is the session context a statement runs under: a tenant, a verified
// subject, both, or neither (the zero value).
type access struct {
	tenant  string
	subject db.Subject
}

func asTenant(tenant string) access             { return access{tenant: tenant} }
func asSubject(s db.Subject) access             { return access{subject: s} }
func asBoth(tenant string, s db.Subject) access { return access{tenant: tenant, subject: s} }

func (f *fixture) run(p *pgxpool.Pool, a access, fn func(db.DBTX) error) error {
	if a == (access{}) {
		return fn(p)
	}
	return db.InTx(f.ctx, p, func(tx pgx.Tx) error {
		if a.tenant != "" {
			if err := db.SetTenant(f.ctx, tx, scope(a.tenant)); err != nil {
				return err
			}
		}
		if a.subject != (db.Subject{}) {
			if err := db.SetSubject(f.ctx, tx, a.subject); err != nil {
				return err
			}
		}
		return fn(tx)
	})
}

// execAs runs sql under a and returns the number of rows affected.
func (f *fixture) execAs(p *pgxpool.Pool, a access, sql string, args ...any) (int64, error) {
	var n int64
	err := f.run(p, a, func(q db.DBTX) error {
		tag, err := q.Exec(f.ctx, sql, args...)
		n = tag.RowsAffected()
		return err
	})
	return n, err
}

// countAs runs a single-integer query under a.
func (f *fixture) countAs(t *testing.T, p *pgxpool.Pool, a access, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := f.run(p, a, func(q db.DBTX) error { return q.QueryRow(f.ctx, sql, args...).Scan(&n) }); err != nil {
		t.Fatalf("count %q: %v", sql, err)
	}
	return n
}

// exec and count run in tenant's context, or with no context when tenant is empty.
func (f *fixture) exec(p *pgxpool.Pool, tenant, sql string, args ...any) (int64, error) {
	return f.execAs(p, asTenant(tenant), sql, args...)
}

func (f *fixture) count(t *testing.T, p *pgxpool.Pool, tenant, sql string, args ...any) int {
	t.Helper()
	return f.countAs(t, p, asTenant(tenant), sql, args...)
}

const insertTenant = `INSERT INTO merchant.tenants (id, tenant_id, display_name, created_at_utc, updated_at_utc)
	VALUES ($1::uuid, $2, $3, $4, $4)`

const insertMerchant = `INSERT INTO merchant.merchants
	(id, merchant_id, tenant_id, environment, display_name, status, revision, created_at_utc, updated_at_utc)
	VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $8)`

func (f *fixture) newTenant(t *testing.T, name string) string {
	t.Helper()
	id := ids.NewPublic(ids.Tenant)
	if _, err := f.exec(f.gw, id, insertTenant, ids.NewInternal(), id, name, t0); err != nil {
		t.Fatalf("create tenant %s: %v", name, err)
	}
	return id
}

func (f *fixture) newMerchant(t *testing.T, tenant, name string) string {
	t.Helper()
	return f.newMerchantIn(t, tenant, "TEST", name)
}

func (f *fixture) newMerchantIn(t *testing.T, tenant, environment, name string) string {
	t.Helper()
	id := ids.NewPublic(ids.Merchant)
	if _, err := f.exec(f.gw, tenant, insertMerchant, ids.NewInternal(), id, tenant, environment, name, "DRAFT", 1, t0); err != nil {
		t.Fatalf("create merchant %s: %v", name, err)
	}
	return id
}

func sqlState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	if err != nil {
		return "error: " + err.Error()
	}
	return "no error"
}

func wantState(t *testing.T, what string, err error, want string) {
	t.Helper()
	if got := sqlState(err); got != want {
		t.Errorf("%s: got %s, want SQLSTATE %s", what, got, want)
	}
}
