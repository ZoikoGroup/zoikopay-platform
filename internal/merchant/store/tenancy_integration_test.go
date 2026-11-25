//go:build integration

package store_test

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/platform/ids"
)

// TestTenantIsolation checks BC-01's tenants and merchants tables against the
// real migrations, applied by the approved runner exactly as `make migrate`
// does: forced row-level security (03-04 CELL-002, ADR 0005 §6), least
// privilege, immutable identity and no deletion (04-03 §2, MER-INV-24).
func TestTenantIsolation(t *testing.T) {
	f := setup(t)
	pg := f.pg

	// Synthetic tenants: A has two merchants, B has one.
	tenantA := f.newTenant(t, "Synthetic Tenant A")
	tenantB := f.newTenant(t, "Synthetic Tenant B")
	merA1 := f.newMerchant(t, tenantA, "A One")
	merA2 := f.newMerchant(t, tenantA, "A Two")
	merB1 := f.newMerchant(t, tenantB, "B One")

	t.Run("each tenant sees only its own tenant row and merchants", func(t *testing.T) {
		for _, c := range []struct {
			tenant    string
			merchants []string
		}{{tenantA, []string{merA1, merA2}}, {tenantB, []string{merB1}}} {
			if n := f.count(t, f.gw, c.tenant, `SELECT count(*) FROM merchant.tenants`); n != 1 {
				t.Errorf("tenant %s sees %d tenant rows, want 1", c.tenant, n)
			}
			if n := f.count(t, f.gw, c.tenant, `SELECT count(*) FROM merchant.tenants WHERE tenant_id = $1`, c.tenant); n != 1 {
				t.Errorf("tenant %s cannot see its own tenant row", c.tenant)
			}
			if n := f.count(t, f.gw, c.tenant, `SELECT count(*) FROM merchant.merchants`); n != len(c.merchants) {
				t.Errorf("tenant %s sees %d merchants, want %d", c.tenant, n, len(c.merchants))
			}
			if n := f.count(t, f.gw, c.tenant, `SELECT count(*) FROM merchant.merchants WHERE merchant_id = ANY($1)`, c.merchants); n != len(c.merchants) {
				t.Errorf("tenant %s cannot see all of its own merchants", c.tenant)
			}
		}
	})

	t.Run("a cross-tenant lookup by ID finds nothing", func(t *testing.T) {
		if n := f.count(t, f.gw, tenantA, `SELECT count(*) FROM merchant.merchants WHERE merchant_id = $1`, merB1); n != 0 {
			t.Errorf("tenant A can see tenant B's merchant")
		}
		if n := f.count(t, f.gw, tenantA, `SELECT count(*) FROM merchant.tenants WHERE tenant_id = $1`, tenantB); n != 0 {
			t.Errorf("tenant A can see tenant B's tenant row")
		}
	})

	t.Run("without a tenant context nothing is visible or writable", func(t *testing.T) {
		for _, p := range []struct {
			role string
			pool *pgxpool.Pool
		}{{"zp_gateway", f.gw}, {"zp_migrator (owner, FORCE RLS)", f.mig}} {
			for _, table := range []string{"merchant.tenants", "merchant.merchants"} {
				if n := f.count(t, p.pool, "", `SELECT count(*) FROM `+table); n != 0 {
					t.Errorf("%s sees %d rows of %s with no tenant set", p.role, n, table)
				}
			}
		}
		id := ids.NewPublic(ids.Tenant)
		_, err := f.exec(f.gw, "", insertTenant, ids.NewInternal(), id, "No Context", t0)
		wantState(t, "insert tenant with no context", err, insufficientPrivilege)
		_, err = f.exec(f.gw, "", insertMerchant, ids.NewInternal(), ids.NewPublic(ids.Merchant), tenantA, "TEST", "No Context", "DRAFT", 1, t0)
		wantState(t, "insert merchant with no context", err, insufficientPrivilege)
	})

	t.Run("rows cannot be written for another tenant", func(t *testing.T) {
		_, err := f.exec(f.gw, tenantA, insertMerchant, ids.NewInternal(), ids.NewPublic(ids.Merchant), tenantB, "TEST", "Smuggled", "DRAFT", 1, t0)
		wantState(t, "tenant A inserts a merchant for tenant B", err, insufficientPrivilege)
		other := ids.NewPublic(ids.Tenant)
		_, err = f.exec(f.gw, tenantA, insertTenant, ids.NewInternal(), other, "Smuggled Tenant", t0)
		wantState(t, "tenant A inserts a different tenant row", err, insufficientPrivilege)
	})

	t.Run("another tenant's rows cannot be updated", func(t *testing.T) {
		n, err := f.exec(f.gw, tenantA, `UPDATE merchant.merchants SET display_name = 'Hijacked', revision = revision + 1 WHERE merchant_id = $1`, merB1)
		if err != nil || n != 0 {
			t.Errorf("tenant A updating tenant B's merchant: %d rows, %v; want 0 rows", n, err)
		}
		n, err = f.exec(f.gw, tenantA, `UPDATE merchant.tenants SET display_name = 'Hijacked' WHERE tenant_id = $1`, tenantB)
		if err != nil || n != 0 {
			t.Errorf("tenant A updating tenant B's tenant row: %d rows, %v; want 0 rows", n, err)
		}
		if n := f.count(t, f.gw, tenantB, `SELECT count(*) FROM merchant.merchants WHERE display_name = 'Hijacked'`); n != 0 {
			t.Errorf("tenant B's merchant was changed by tenant A")
		}
	})

	t.Run("a merchant needs an existing tenant", func(t *testing.T) {
		ghost := ids.NewPublic(ids.Tenant) // valid ID, no tenants row
		_, err := f.exec(f.gw, ghost, insertMerchant, ids.NewInternal(), ids.NewPublic(ids.Merchant), ghost, "TEST", "Orphan", "DRAFT", 1, t0)
		wantState(t, "merchant for a tenant that does not exist", err, foreignKeyViolation)
	})

	t.Run("identity, tenant and environment cannot change", func(t *testing.T) {
		// The runtime role has no UPDATE grant on these columns.
		for _, stmt := range []string{
			`UPDATE merchant.merchants SET tenant_id = '` + tenantB + `' WHERE merchant_id = $1`,
			`UPDATE merchant.merchants SET environment = 'LIVE' WHERE merchant_id = $1`,
			`UPDATE merchant.merchants SET merchant_id = merchant_id WHERE merchant_id = $1`,
			`UPDATE merchant.merchants SET created_at_utc = created_at_utc WHERE merchant_id = $1`,
		} {
			_, err := f.exec(f.gw, tenantA, stmt, merA1)
			wantState(t, "zp_gateway: "+stmt, err, insufficientPrivilege)
		}
		_, err := f.exec(f.gw, tenantA, `UPDATE merchant.tenants SET tenant_id = tenant_id WHERE tenant_id = $1`, tenantA)
		wantState(t, "zp_gateway changes tenant_id", err, insufficientPrivilege)

		// The owner holds every privilege, so the guard triggers must stop it.
		for _, stmt := range []string{
			`UPDATE merchant.merchants SET environment = 'LIVE', revision = revision + 1 WHERE merchant_id = $1`,
			`UPDATE merchant.merchants SET merchant_id = '` + ids.NewPublic(ids.Merchant) + `', revision = revision + 1 WHERE merchant_id = $1`,
			`UPDATE merchant.merchants SET id = '` + ids.NewInternal() + `', revision = revision + 1 WHERE merchant_id = $1`,
		} {
			_, err := f.exec(f.mig, tenantA, stmt, merA1)
			wantState(t, "owner: "+stmt, err, restrictViolation)
		}
		_, err = f.exec(f.mig, tenantA, `UPDATE merchant.tenants SET created_at_utc = created_at_utc - interval '1 day' WHERE tenant_id = $1`, tenantA)
		wantState(t, "owner changes a tenant's created_at_utc", err, restrictViolation)
	})

	t.Run("merchant revision increases by exactly one", func(t *testing.T) {
		later := t0.Add(time.Hour)
		if _, err := f.exec(f.gw, tenantA, `UPDATE merchant.merchants SET status = 'SUBMITTED', revision = revision + 1, updated_at_utc = $2 WHERE merchant_id = $1`, merA2, later); err != nil {
			t.Fatalf("a valid update failed: %v", err)
		}
		if n := f.count(t, f.gw, tenantA, `SELECT count(*) FROM merchant.merchants WHERE merchant_id = $1 AND revision = 2 AND status = 'SUBMITTED'`, merA2); n != 1 {
			t.Errorf("valid update not applied")
		}
		for what, stmt := range map[string]string{
			"revision unchanged":      `UPDATE merchant.merchants SET status = 'UNDER_REVIEW' WHERE merchant_id = $1`,
			"revision skips ahead":    `UPDATE merchant.merchants SET status = 'UNDER_REVIEW', revision = revision + 2 WHERE merchant_id = $1`,
			"revision goes backwards": `UPDATE merchant.merchants SET status = 'UNDER_REVIEW', revision = revision - 1 WHERE merchant_id = $1`,
			"updated_at_utc backwards": `UPDATE merchant.merchants SET status = 'UNDER_REVIEW', revision = revision + 1,
				updated_at_utc = updated_at_utc - interval '1 minute' WHERE merchant_id = $1`,
		} {
			_, err := f.exec(f.gw, tenantA, stmt, merA2)
			wantState(t, what, err, restrictViolation)
		}
	})

	t.Run("rows are never deleted, even by the owner", func(t *testing.T) {
		for _, table := range []string{"merchant.tenants", "merchant.merchants"} {
			_, err := f.exec(f.gw, tenantA, `DELETE FROM `+table)
			wantState(t, "zp_gateway DELETE "+table, err, insufficientPrivilege)
			_, err = f.exec(f.gw, tenantA, `TRUNCATE `+table+` CASCADE`)
			wantState(t, "zp_gateway TRUNCATE "+table, err, insufficientPrivilege)
		}
		_, err := f.exec(f.mig, tenantA, `DELETE FROM merchant.merchants WHERE merchant_id = $1`, merA1)
		wantState(t, "owner DELETE merchant", err, restrictViolation)
		_, err = f.exec(f.mig, tenantA, `DELETE FROM merchant.tenants WHERE tenant_id = $1`, tenantA)
		wantState(t, "owner DELETE tenant", err, restrictViolation)
		// CASCADE, because memberships reference merchants: without it PostgreSQL
		// refuses before the guard runs. With it, the guards must still refuse.
		_, err = f.exec(f.mig, "", `TRUNCATE merchant.merchants CASCADE`)
		wantState(t, "owner TRUNCATE merchants CASCADE", err, restrictViolation)
		_, err = f.exec(f.mig, "", `TRUNCATE merchant.tenants CASCADE`)
		wantState(t, "owner TRUNCATE tenants CASCADE", err, restrictViolation)
		if n := f.count(t, f.gw, tenantA, `SELECT count(*) FROM merchant.merchants`); n != 2 {
			t.Errorf("tenant A has %d merchants after delete attempts, want 2", n)
		}
	})

	t.Run("the runtime role cannot change the schema or its policies", func(t *testing.T) {
		for _, stmt := range []string{
			`ALTER TABLE merchant.merchants DISABLE ROW LEVEL SECURITY`,
			`ALTER TABLE merchant.merchants NO FORCE ROW LEVEL SECURITY`,
			`DROP POLICY tenant_isolation ON merchant.tenants`,
			`CREATE POLICY see_all ON merchant.merchants USING (true)`,
			`DROP TRIGGER merchant_guard ON merchant.merchants`,
			`CREATE TABLE merchant.sneaky (id int)`,
		} {
			_, err := f.exec(f.gw, "", stmt)
			wantState(t, "zp_gateway: "+stmt, err, insufficientPrivilege)
		}
	})

	t.Run("other deployables' roles cannot read the merchant schema", func(t *testing.T) {
		for _, role := range []string{"zp_execution", "zp_finance", "zp_governance", "zp_relay"} {
			p := pg.Pool(t, role)
			for _, table := range []string{"merchant.tenants", "merchant.merchants"} {
				_, err := f.exec(p, tenantA, `SELECT 1 FROM `+table)
				wantState(t, role+" reads "+table, err, insufficientPrivilege)
			}
		}
	})

	t.Run("IDs, states and names are format-checked", func(t *testing.T) {
		// Tenant IDs must be ten_ + UUIDv7; set the context to the bad ID so
		// the CHECK constraint, not row-level security, is what refuses it.
		for _, bad := range []string{"ten_northwind", "ten_00000000000040008000000000000000", "mrch_" + ids.NewPublic(ids.Tenant)[4:]} {
			_, err := f.exec(f.gw, bad, insertTenant, ids.NewInternal(), bad, "Bad ID", t0)
			wantState(t, "tenant_id "+bad, err, checkViolation)
		}
		fresh := ids.NewPublic(ids.Tenant)
		_, err := f.exec(f.gw, fresh, insertTenant, "00000000-0000-4000-8000-000000000001", fresh, "UUIDv4 internal id", t0)
		wantState(t, "tenant with a UUIDv4 internal id", err, checkViolation)

		goodMerchant := func(merchantID, env, name, status string, revision int) error {
			_, err := f.exec(f.gw, tenantA, insertMerchant, ids.NewInternal(), merchantID, tenantA, env, name, status, revision, t0)
			return err
		}
		for what, err := range map[string]error{
			"merchant_id with the 04-03 mrch_ prefix (Q10)":   goodMerchant("mrch_"+ids.NewPublic(ids.Merchant)[4:], "TEST", "X", "DRAFT", 1),
			"merchant_id that is not a UUIDv7":                goodMerchant("mer_00000000000040008000000000000000", "TEST", "X", "DRAFT", 1),
			"environment PROD":                                goodMerchant(ids.NewPublic(ids.Merchant), "PROD", "X", "DRAFT", 1),
			"capability state ACTIVE is not a merchant state": goodMerchant(ids.NewPublic(ids.Merchant), "TEST", "X", "ACTIVE", 1),
			"lower-case state":                                goodMerchant(ids.NewPublic(ids.Merchant), "TEST", "X", "draft", 1),
			"blank display name":                              goodMerchant(ids.NewPublic(ids.Merchant), "TEST", "   ", "DRAFT", 1),
			"revision 0":                                      goodMerchant(ids.NewPublic(ids.Merchant), "TEST", "X", "DRAFT", 0),
		} {
			wantState(t, what, err, checkViolation)
		}
	})

	t.Run("public IDs are unique", func(t *testing.T) {
		_, err := f.exec(f.gw, tenantA, insertMerchant, ids.NewInternal(), merA1, tenantA, "TEST", "Duplicate", "DRAFT", 1, t0)
		wantState(t, "duplicate merchant_id", err, uniqueViolation)
	})
}
