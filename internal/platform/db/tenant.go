package db

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
)

// Tenant is the authenticated scope of one transaction. It is derived on
// the server from the verified principal, never from request fields
// (02-02 §2.2, 03-05).
type Tenant struct {
	Environment   string // "TEST" or "LIVE"
	CellID        string
	LegalEntityID string
	TenantID      string
}

// Session settings read by row-level security policies. They are set with
// set_config(..., is_local => true), so they last only until the end of the
// transaction and never leak to the next user of a pooled connection.
const (
	SettingTenant      = "zp.tenant_id"
	SettingEnvironment = "zp.environment"
	SettingCell        = "zp.cell_id"
	SettingLegalEntity = "zp.legal_entity_id"
)

// ErrNoTenant is returned when a tenant transaction is started without a full scope.
var ErrNoTenant = errors.New("tenant context is incomplete")

func (t Tenant) validate() error {
	if t.TenantID == "" || t.CellID == "" || t.LegalEntityID == "" || (t.Environment != "TEST" && t.Environment != "LIVE") {
		return fmt.Errorf("%w: %+v", ErrNoTenant, t)
	}
	return nil
}

// SetTenant binds tx to t. Row-level security then limits every read and
// write in tx to t's rows; without it, tenant tables return nothing and
// reject writes (fail closed).
func SetTenant(ctx context.Context, tx pgx.Tx, t Tenant) error {
	if err := t.validate(); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true), set_config($7, $8, true)`,
		SettingTenant, t.TenantID, SettingEnvironment, t.Environment, SettingCell, t.CellID, SettingLegalEntity, t.LegalEntityID)
	if err != nil {
		return fmt.Errorf("set tenant context: %w", err)
	}
	return nil
}

// InTenantTx is InTx with the tenant context set before fn runs.
func InTenantTx(ctx context.Context, b Beginner, t Tenant, fn func(pgx.Tx) error) error {
	if err := t.validate(); err != nil {
		return err
	}
	return InTx(ctx, b, func(tx pgx.Tx) error {
		if err := SetTenant(ctx, tx, t); err != nil {
			return err
		}
		return fn(tx)
	})
}

var identifier = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

// mustIdent guards the SQL builders below: schema, table and role names are
// developer constants, but a typo must fail loudly, not produce odd SQL.
func mustIdent(names ...string) {
	for _, n := range names {
		if !identifier.MatchString(n) {
			panic(fmt.Sprintf("db: %q is not a lower-case SQL identifier", n))
		}
	}
}

// TenantRLSSQL enables and forces row-level security on schema.table and adds
// the tenant policy: a row is visible and writable only when its tenant_id
// equals the transaction's zp.tenant_id. FORCE applies the policy to the
// table owner too, so even the migrator must set a tenant to see rows.
// The table must have a NOT NULL tenant_id text column.
func TenantRLSSQL(schema, table string) string {
	mustIdent(schema, table)
	t := Table(schema, table)
	return `ALTER TABLE ` + t + ` ENABLE ROW LEVEL SECURITY;
ALTER TABLE ` + t + ` FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ` + t + `
    USING (tenant_id = current_setting('` + SettingTenant + `', true))
    WITH CHECK (tenant_id = current_setting('` + SettingTenant + `', true));`
}

// SystemRLSSQL lets one system role (for example zp_relay) act on all rows of
// schema.table regardless of tenant. Use only for platform processes that
// carry no tenant, such as the outbox relay; their column privileges must
// still be minimal.
func SystemRLSSQL(schema, table, role string) string {
	mustIdent(schema, table, role)
	return `CREATE POLICY system_` + role + ` ON ` + Table(schema, table) + ` TO ` + role + ` USING (true) WITH CHECK (true);`
}

// SchemaUsageSQL grants USAGE on schema to roles (needed before any table grant).
func SchemaUsageSQL(schema string, roles ...string) string {
	mustIdent(append([]string{schema}, roles...)...)
	out := ""
	for _, r := range roles {
		out += `GRANT USAGE ON SCHEMA ` + pgx.Identifier{schema}.Sanitize() + ` TO ` + r + ";\n"
	}
	return out
}
