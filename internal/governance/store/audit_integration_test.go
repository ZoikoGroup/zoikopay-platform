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

	"github.com/zoiko/zoikopay/internal/governance/store"
	"github.com/zoiko/zoikopay/internal/platform/audit"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
	"github.com/zoiko/zoikopay/internal/platform/migrate"
)

const (
	issuer  = "http://localhost:8180/realms/zoikopay"
	alice   = "00000000-0000-4000-8000-0000000000a1"
	tenantA = "ten_019abc000000700080000000000000a1"
	tenantB = "ten_019abc000000700080000000000000b1"
)

// SQLSTATE codes.
const (
	insufficientPrivilege = "42501"
	restrictViolation     = "23001"
	checkViolation        = "23514"
)

func state(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	if err != nil {
		return "error: " + err.Error()
	}
	return "no error"
}

func want(t *testing.T, what string, err error, code string) {
	t.Helper()
	if got := state(err); got != code {
		t.Errorf("%s: got %s, want SQLSTATE %s", what, got, code)
	}
}

func tenantScope(tenant string) db.Tenant {
	return db.Tenant{Environment: "TEST", CellID: "zp:none", LegalEntityID: "zp:none", TenantID: tenant}
}

// as runs sql as pool's role, in tenant's context when tenant is set.
func as(ctx context.Context, p *pgxpool.Pool, tenant, sql string, args ...any) error {
	if tenant == "" {
		_, err := p.Exec(ctx, sql, args...)
		return err
	}
	return db.InTenantTx(ctx, p, tenantScope(tenant), func(tx pgx.Tx) error { _, err := tx.Exec(ctx, sql, args...); return err })
}

func count(t *testing.T, ctx context.Context, p *pgxpool.Pool, tenant string) int {
	t.Helper()
	var n int
	q := func(r pgx.Row) { _ = r.Scan(&n) }
	var err error
	if tenant == "" {
		err = p.QueryRow(ctx, `SELECT count(*) FROM governance.audit_events`).Scan(&n)
	} else {
		err = db.InTenantTx(ctx, p, tenantScope(tenant), func(tx pgx.Tx) error {
			q(tx.QueryRow(ctx, `SELECT count(*) FROM governance.audit_events`))
			return nil
		})
	}
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func entry(tenant string, status int, outcome audit.Outcome, reason string) audit.Entry {
	e := audit.Entry{
		TraceID: "0123456789abcdef0123456789abcdef", Actor: &audit.Actor{Issuer: issuer, Subject: alice}, Environment: "TEST",
		TenantID: tenant, Action: "getMerchant", ResourceType: "merchant", ResourceHash: audit.ResourceHash("merchant", "mer_x"),
		Outcome: outcome, HTTPStatus: status, Reason: reason,
	}
	return e
}

const rawInsert = `INSERT INTO governance.audit_events
	(occurred_at_utc, trace_id, actor_issuer, actor_subject, environment, tenant_id, action, resource_type, resource_hash, outcome, http_status, reason)
	VALUES ($1, $2, $3, $4, 'TEST', $5, $6, $7, $8, $9, $10, $11)`

// TestAuditLog checks governance.audit_events against the real migrations
// (OPEN_QUESTIONS Q38): append-only even for the owner, role separation, the
// database clock, format checks and tenant isolation.
func TestAuditLog(t *testing.T) {
	ctx := context.Background()
	pg := dbtest.Start(t)
	r := migrate.Runner{Pool: pg.Pool(t, "zp_migrator"), Source: os.DirFS(filepath.Join(dbtest.RepoRoot(t), "db", "migrations"))}
	if _, err := r.Up(ctx); err != nil {
		t.Fatalf("apply real migrations: %v", err)
	}
	auditPool, owner := pg.Pool(t, "zp_audit"), pg.Pool(t, "zp_migrator")
	st := store.NewAuditStore(auditPool)

	for _, e := range []audit.Entry{
		entry(tenantA, 200, audit.Allowed, ""),
		entry(tenantA, 403, audit.Denied, "permission_denied"),
		entry(tenantB, 200, audit.Allowed, ""),
		entry("", 404, audit.Denied, "resource_not_found"), // no tenant: Q38 38.10
		{TraceID: "fedcba9876543210fedcba9876543210", Environment: "TEST", Action: "authenticate", Outcome: audit.Denied, HTTPStatus: 401, Reason: "authentication_required"},
	} {
		if err := st.Record(ctx, e); err != nil {
			t.Fatalf("record %+v: %v", e, err)
		}
	}

	t.Run("rule 5: a tenant reads only its own entries", func(t *testing.T) {
		for tenant, n := range map[string]int{tenantA: 2, tenantB: 1} {
			if got := count(t, ctx, auditPool, tenant); got != n {
				t.Errorf("tenant %s sees %d entries; want %d", tenant, got, n)
			}
			list, err := st.ListForTenant(ctx, "TEST", tenant, 100)
			if err != nil {
				t.Fatal(err)
			}
			for _, e := range list {
				if e.TenantID != tenant {
					t.Errorf("tenant %s read an entry of %q", tenant, e.TenantID)
				}
			}
			if len(list) != n {
				t.Errorf("ListForTenant(%s) = %d entries; want %d", tenant, len(list), n)
			}
		}
		if got := count(t, ctx, auditPool, ""); got != 0 {
			t.Errorf("without a tenant context zp_audit sees %d entries; want 0", got)
		}
		if got := count(t, ctx, owner, ""); got != 0 {
			t.Errorf("the owner sees %d entries without a tenant (FORCE RLS); want 0", got)
		}
		if got := count(t, ctx, pg.Pool(t, "postgres"), ""); got != 5 {
			t.Fatalf("superuser sees %d entries; want all 5 (fixture check)", got)
		}
	})

	t.Run("rule 5: entries cannot be written for another tenant", func(t *testing.T) {
		err := as(ctx, auditPool, tenantA, rawInsert, time.Now(), "0123456789abcdef0123456789abcdef", issuer, alice,
			tenantB, "getMerchant", "merchant", audit.ResourceHash("merchant", "mer_x"), "ALLOWED", 200, nil)
		want(t, "insert tenant B's entry in tenant A's context", err, insufficientPrivilege)
		err = as(ctx, auditPool, "", rawInsert, time.Now(), "0123456789abcdef0123456789abcdef", issuer, alice,
			tenantB, "getMerchant", "merchant", audit.ResourceHash("merchant", "mer_x"), "ALLOWED", 200, nil)
		want(t, "insert a tenant entry with no tenant context", err, insufficientPrivilege)
	})

	t.Run("rule 1: no update, delete or truncate, even by the owner", func(t *testing.T) {
		su := pg.Pool(t, "postgres") // sees every row; used to prove nothing changed
		snapshot := func() string {
			var s string
			if err := su.QueryRow(ctx, `SELECT coalesce(string_agg(row_to_json(e)::text, E'\n' ORDER BY id), '') FROM governance.audit_events e`).Scan(&s); err != nil {
				t.Fatal(err)
			}
			return s
		}
		before := snapshot()
		for _, stmt := range []string{
			`UPDATE governance.audit_events SET outcome = 'ALLOWED'`,
			`DELETE FROM governance.audit_events`,
			`TRUNCATE governance.audit_events`,
		} {
			want(t, "zp_audit: "+stmt, as(ctx, auditPool, tenantA, stmt), insufficientPrivilege)
			// The owner is under FORCE RLS with no policy of its own, so it sees no
			// rows: UPDATE and DELETE touch nothing, TRUNCATE hits the guard. Either
			// way nothing may change; the snapshot below proves it.
			if err := as(ctx, owner, tenantA, stmt); err != nil && state(err) != restrictViolation {
				t.Errorf("owner: %s: got %s, want refusal (23001) or no effect", stmt, state(err))
			}
		}
		// Even the superuser, which bypasses row-level security, hits the guards.
		_, err := su.Exec(ctx, `UPDATE governance.audit_events SET reason = 'edited'`)
		want(t, "superuser UPDATE", err, restrictViolation)
		_, err = su.Exec(ctx, `DELETE FROM governance.audit_events`)
		want(t, "superuser DELETE", err, restrictViolation)
		if got := count(t, ctx, su, ""); got != 5 {
			t.Errorf("%d entries left after tampering attempts; want 5", got)
		}
		if after := snapshot(); after != before {
			t.Errorf("entries changed by tampering attempts:\nbefore %s\nafter  %s", before, after)
		}
	})

	t.Run("role separation: only zp_audit can read or write, and nothing else", func(t *testing.T) {
		for _, role := range []string{"zp_gateway", "zp_execution", "zp_finance", "zp_governance", "zp_relay"} {
			p := pg.Pool(t, role)
			want(t, role+" reads the log", as(ctx, p, tenantA, `SELECT 1 FROM governance.audit_events`), insufficientPrivilege)
			want(t, role+" writes the log", as(ctx, p, tenantA, rawInsert, time.Now(), "0123456789abcdef0123456789abcdef", issuer, alice,
				tenantA, "getMerchant", "merchant", audit.ResourceHash("merchant", "mer_x"), "ALLOWED", 200, nil), insufficientPrivilege)
		}
		for _, stmt := range []string{
			`SELECT 1 FROM governance.outbox_events`,
			`SELECT 1 FROM governance.idempotency_registry`,
			`CREATE TABLE governance.sneaky (id int)`,
			`ALTER TABLE governance.audit_events DISABLE ROW LEVEL SECURITY`,
			`DROP TRIGGER audit_events_append_only ON governance.audit_events`,
		} {
			want(t, "zp_audit: "+stmt, as(ctx, auditPool, "", stmt), insufficientPrivilege)
		}
	})

	t.Run("rule 2: the database clock sets occurred_at", func(t *testing.T) {
		before := time.Now().UTC().Add(-time.Minute)
		err := as(ctx, auditPool, tenantA, rawInsert, time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC), "00000000000000000000000000000abc",
			issuer, alice, tenantA, "getMerchant", "merchant", audit.ResourceHash("merchant", "mer_x"), "ALLOWED", 200, nil)
		if err != nil {
			t.Fatal(err)
		}
		list, err := st.ListForTenant(ctx, "TEST", tenantA, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range list {
			if e.TraceID == "00000000000000000000000000000abc" && e.OccurredAt.Before(before) {
				t.Errorf("occurred_at %s came from the application, not the database clock", e.OccurredAt)
			}
			if e.OccurredAt.Location() != time.UTC {
				t.Errorf("occurred_at %s is not UTC", e.OccurredAt)
			}
		}
	})

	t.Run("rule 4: token-like and free-text values are refused by the database", func(t *testing.T) {
		const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"
		for name, args := range map[string][]any{
			"token as subject":    {issuer, jwt, "getMerchant", nil},
			"token as action":     {issuer, alice, jwt, nil},
			"password in reason":  {issuer, alice, "getMerchant", "password=hunter2"},
			"free text in action": {issuer, alice, "read merchant for bob", nil},
			"half an actor":       {nil, alice, "getMerchant", nil},
			"issuer not a URL":    {"zoikopay", alice, "getMerchant", nil},
		} {
			err := as(ctx, auditPool, tenantA, rawInsert, time.Now(), "0123456789abcdef0123456789abcdef", args[0], args[1],
				tenantA, args[2], "merchant", audit.ResourceHash("merchant", "mer_x"), "ALLOWED", 200, args[3])
			want(t, name, err, checkViolation)
		}
		for name, vals := range map[string][]any{
			"raw id instead of a hash":   {"merchant", "mer_x", "ALLOWED", 200},
			"outcome contradicts status": {"merchant", audit.ResourceHash("merchant", "mer_x"), "ALLOWED", 403},
			"client trace ID":            {"merchant", audit.ResourceHash("merchant", "mer_x"), "ALLOWED", 200},
		} {
			traceID := "0123456789abcdef0123456789abcdef"
			if name == "client trace ID" {
				traceID = "client-supplied-trace"
			}
			err := as(ctx, auditPool, tenantA, rawInsert, time.Now(), traceID, issuer, alice, tenantA, "getMerchant", vals[0], vals[1], vals[2], vals[3], nil)
			want(t, name, err, checkViolation)
		}
	})

	t.Run("the store refuses invalid entries before the database", func(t *testing.T) {
		e := entry(tenantA, 200, audit.Allowed, "")
		e.Actor.Subject = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"
		if err := st.Record(ctx, e); !errors.Is(err, audit.ErrInvalidEntry) {
			t.Errorf("err = %v; want audit.ErrInvalidEntry", err)
		}
	})
}
