//go:build integration

package store_test

import (
	"strings"
	"testing"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/ids"
)

// Synthetic identities. keycloak is the local Zoiko iD stand-in; other is a
// second, made-up issuer: the same subject string from two issuers must
// never be treated as one person.
const (
	keycloak = "http://localhost:8180/realms/zoikopay"
	other    = "https://other-issuer.example.test/realms/other"
)

var (
	alice   = db.Subject{Issuer: keycloak, Subject: "00000000-0000-4000-8000-00000000a11c"}
	bob     = db.Subject{Issuer: keycloak, Subject: "00000000-0000-4000-8000-000000000b0b"}
	carol   = db.Subject{Issuer: keycloak, Subject: "00000000-0000-4000-8000-00000000ca01"}
	twin    = db.Subject{Issuer: other, Subject: alice.Subject} // alice's subject, another issuer
	nobody  = db.Subject{Issuer: keycloak, Subject: "00000000-0000-4000-8000-000000000000"}
	maker   = db.Subject{Issuer: keycloak, Subject: "00000000-0000-4000-8000-0000000000a1"} // e.g. a PIAM or MOWN
	checker = db.Subject{Issuer: keycloak, Subject: "00000000-0000-4000-8000-0000000000a2"} // an independent PIAM or MOWN
)

const insertMembership = `INSERT INTO merchant.memberships
	(id, issuer, subject, tenant_id, merchant_id, environment, persona,
	 granted_by_issuer, granted_by_subject, approved_by_issuer, approved_by_subject, granted_at_utc,
	 effective_from_utc, expires_at_utc)
	VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`

const revokeMembership = `UPDATE merchant.memberships
	SET revoked_at_utc = $2, revoked_by_issuer = $3, revoked_by_subject = $4 WHERE id = $1::uuid`

// grantTime is when fixture grants are approved: an hour ago on the real
// clock, because row-level security compares validity with the database's now().
var grantTime = time.Now().UTC().Truncate(time.Second).Add(-time.Hour)

type grant struct {
	member         db.Subject
	tenant         string
	merchant       string // "" for every merchant of the tenant
	environment    string // default TEST
	persona        string
	maker, checker db.Subject // default maker and checker
	effectiveFrom  time.Time  // default grantTime
	expiresAt      time.Time  // default grantTime + 48h
}

// insertGrant writes g under a and returns the membership's internal ID.
func (f *fixture) insertGrant(a access, g grant) (string, error) {
	if g.environment == "" {
		g.environment = "TEST"
	}
	if g.maker == (db.Subject{}) {
		g.maker = maker
	}
	if g.checker == (db.Subject{}) {
		g.checker = checker
	}
	if g.effectiveFrom.IsZero() {
		g.effectiveFrom = grantTime
	}
	if g.expiresAt.IsZero() {
		g.expiresAt = grantTime.Add(48 * time.Hour)
	}
	var merchantID any
	if g.merchant != "" {
		merchantID = g.merchant
	}
	id := ids.NewInternal()
	_, err := f.execAs(f.gw, a, insertMembership, id, g.member.Issuer, g.member.Subject, g.tenant, merchantID,
		g.environment, g.persona, g.maker.Issuer, g.maker.Subject, g.checker.Issuer, g.checker.Subject, grantTime,
		g.effectiveFrom, g.expiresAt)
	return id, err
}

// mustGrant writes g in its own tenant's context.
func (f *fixture) mustGrant(t *testing.T, g grant) string {
	t.Helper()
	id, err := f.insertGrant(asTenant(g.tenant), g)
	if err != nil {
		t.Fatalf("grant %+v: %v", g, err)
	}
	return id
}

// TestMemberships checks merchant.memberships against the real migrations:
// authority comes from these rows, keyed by the verified (issuer, subject)
// pair (02-02 §2.2); tenant isolation is forced; the caller can see only its
// own active grants before choosing a tenant; grants need an independent
// checker and are immutable; revocation is final (02-02 §3).
func TestMemberships(t *testing.T) {
	f := setup(t)

	tenantA := f.newTenant(t, "Synthetic Tenant A")
	tenantB := f.newTenant(t, "Synthetic Tenant B")
	merA1 := f.newMerchant(t, tenantA, "A One")
	merALive := f.newMerchantIn(t, tenantA, "LIVE", "A Live")
	merB1 := f.newMerchant(t, tenantB, "B One")

	f.mustGrant(t, grant{member: alice, tenant: tenantA, persona: "MOWN"})                   // tenant-wide
	f.mustGrant(t, grant{member: alice, tenant: tenantB, merchant: merB1, persona: "MVIEW"}) // one merchant
	f.mustGrant(t, grant{member: bob, tenant: tenantA, merchant: merA1, persona: "MOPS"})
	carolGrant := f.mustGrant(t, grant{member: carol, tenant: tenantA, persona: "MFIN"})
	f.mustGrant(t, grant{member: twin, tenant: tenantB, persona: "MOWN"})

	countMemberships := `SELECT count(*) FROM merchant.memberships`

	t.Run("a tenant sees only its own memberships", func(t *testing.T) {
		if n := f.count(t, f.gw, tenantA, countMemberships); n != 3 {
			t.Errorf("tenant A sees %d memberships, want 3", n)
		}
		if n := f.count(t, f.gw, tenantB, countMemberships); n != 2 {
			t.Errorf("tenant B sees %d memberships, want 2", n)
		}
		if n := f.count(t, f.gw, tenantA, countMemberships+` WHERE tenant_id <> $1`, tenantA); n != 0 {
			t.Errorf("tenant A sees %d memberships of other tenants", n)
		}
	})

	t.Run("a subject sees only its own active memberships, across tenants", func(t *testing.T) {
		for _, c := range []struct {
			who  string
			s    db.Subject
			want int
		}{{"alice", alice, 2}, {"bob", bob, 1}, {"alice's subject from another issuer", twin, 1}, {"unknown subject", nobody, 0}} {
			if n := f.countAs(t, f.gw, asSubject(c.s), countMemberships); n != c.want {
				t.Errorf("%s sees %d memberships, want %d", c.who, n, c.want)
			}
			if n := f.countAs(t, f.gw, asSubject(c.s), countMemberships+` WHERE (issuer, subject) <> ($1, $2)`, c.s.Issuer, c.s.Subject); n != 0 {
				t.Errorf("%s sees %d memberships of other subjects", c.who, n)
			}
		}
		if n := f.countAs(t, f.gw, asSubject(alice), `SELECT count(DISTINCT tenant_id) FROM merchant.memberships WHERE tenant_id IN ($1, $2)`, tenantA, tenantB); n != 2 {
			t.Errorf("alice resolves %d tenants, want 2 (A and B)", n)
		}
		if n := f.countAs(t, f.gw, asSubject(twin), countMemberships+` WHERE issuer = $1`, keycloak); n != 0 {
			t.Errorf("a subject from another issuer sees the Keycloak member's grants")
		}
	})

	t.Run("without a context nothing is visible", func(t *testing.T) {
		if n := f.count(t, f.gw, "", countMemberships); n != 0 {
			t.Errorf("zp_gateway sees %d memberships with no context", n)
		}
		if n := f.count(t, f.mig, "", countMemberships); n != 0 {
			t.Errorf("the owner sees %d memberships with no context (FORCE RLS)", n)
		}
	})

	t.Run("the subject context cannot grant or revoke", func(t *testing.T) {
		_, err := f.insertGrant(asSubject(alice), grant{member: alice, tenant: tenantA, persona: "MDEV"})
		wantState(t, "grant with only a subject context", err, insufficientPrivilege)
		n, err := f.execAs(f.gw, asSubject(carol), revokeMembership, carolGrant, grantTime.Add(time.Minute), carol.Issuer, carol.Subject)
		if err != nil || n != 0 {
			t.Errorf("revoke with only a subject context: %d rows, %v; want 0 rows", n, err)
		}
		_, err = f.insertGrant(asBoth(tenantA, alice), grant{member: alice, tenant: tenantB, persona: "MDEV"})
		wantState(t, "grant into tenant B from tenant A's context", err, insufficientPrivilege)
	})

	t.Run("revoked grants leave the subject lookup but stay in the tenant's history", func(t *testing.T) {
		if n := f.countAs(t, f.gw, asSubject(carol), countMemberships); n != 1 {
			t.Fatalf("carol sees %d memberships before revocation, want 1", n)
		}
		n, err := f.exec(f.gw, tenantA, revokeMembership, carolGrant, grantTime.Add(time.Hour), checker.Issuer, checker.Subject)
		if err != nil || n != 1 {
			t.Fatalf("revoke carol: %d rows, %v", n, err)
		}
		if n := f.countAs(t, f.gw, asSubject(carol), countMemberships); n != 0 {
			t.Errorf("carol still sees %d memberships after revocation", n)
		}
		if n := f.count(t, f.gw, tenantA, countMemberships+` WHERE subject = $1 AND revoked_at_utc IS NOT NULL`, carol.Subject); n != 1 {
			t.Errorf("tenant A lost carol's revoked grant from its history")
		}
		f.mustGrant(t, grant{member: carol, tenant: tenantA, persona: "MFIN"}) // a fresh grant after revocation is allowed
	})

	t.Run("revocation is final and complete", func(t *testing.T) {
		later := grantTime.Add(2 * time.Hour)
		_, err := f.exec(f.gw, tenantA, revokeMembership, carolGrant, later, checker.Issuer, checker.Subject)
		wantState(t, "revoke an already revoked grant again", err, restrictViolation)
		_, err = f.exec(f.gw, tenantA, `UPDATE merchant.memberships SET revoked_at_utc = NULL, revoked_by_issuer = NULL, revoked_by_subject = NULL WHERE id = $1::uuid`, carolGrant)
		wantState(t, "un-revoke", err, restrictViolation)

		active := f.mustGrant(t, grant{member: carol, tenant: tenantA, merchant: merA1, persona: "MVIEW"})
		_, err = f.exec(f.gw, tenantA, `UPDATE merchant.memberships SET revoked_at_utc = $2 WHERE id = $1::uuid`, active, later)
		wantState(t, "revocation without who revoked", err, checkViolation)
		_, err = f.exec(f.gw, tenantA, revokeMembership, active, grantTime.Add(-time.Hour), checker.Issuer, checker.Subject)
		wantState(t, "revocation dated before the grant", err, checkViolation)
		_, err = f.exec(f.gw, tenantA, revokeMembership, active, later, "", "")
		wantState(t, "revocation by an empty identity", err, checkViolation)
	})

	t.Run("grants need a maker and an independent checker", func(t *testing.T) {
		for what, g := range map[string]grant{
			"checker is the maker":        {member: bob, tenant: tenantA, persona: "MDEV", maker: maker, checker: maker},
			"maker grants themselves":     {member: maker, tenant: tenantA, persona: "MDEV"},
			"checker approves themselves": {member: checker, tenant: tenantA, persona: "MDEV"},
			"empty maker subject":         {member: bob, tenant: tenantA, persona: "MDEV", maker: db.Subject{Issuer: keycloak, Subject: ""}},
		} {
			_, err := f.insertGrant(asTenant(tenantA), g)
			wantState(t, what, err, checkViolation)
		}
	})

	t.Run("only the five merchant personas can be granted", func(t *testing.T) {
		for _, persona := range []string{"POR", "PIAM", "PSEC", "SUPER_ADMIN", "mown", "ADMIN", ""} {
			_, err := f.insertGrant(asTenant(tenantA), grant{member: bob, tenant: tenantA, persona: persona})
			wantState(t, "persona "+persona, err, checkViolation)
		}
	})

	t.Run("a scoped grant names the tenant's own merchant in the same environment", func(t *testing.T) {
		for what, g := range map[string]grant{
			"another tenant's merchant":       {member: bob, tenant: tenantA, merchant: merB1, persona: "MVIEW"},
			"a LIVE merchant in a TEST grant": {member: bob, tenant: tenantA, merchant: merALive, environment: "TEST", persona: "MVIEW"},
			"a TEST merchant in a LIVE grant": {member: bob, tenant: tenantA, merchant: merA1, environment: "LIVE", persona: "MVIEW"},
			"a merchant that does not exist":  {member: bob, tenant: tenantA, merchant: ids.NewPublic(ids.Merchant), persona: "MVIEW"},
		} {
			_, err := f.insertGrant(asTenant(tenantA), g)
			wantState(t, what, err, foreignKeyViolation)
		}
		ghost := ids.NewPublic(ids.Tenant)
		_, err := f.insertGrant(asTenant(ghost), grant{member: bob, tenant: ghost, persona: "MVIEW"})
		wantState(t, "a tenant that does not exist", err, foreignKeyViolation)
		f.mustGrant(t, grant{member: bob, tenant: tenantA, merchant: merALive, environment: "LIVE", persona: "MVIEW"})
	})

	t.Run("one active grant per member, scope, environment and persona", func(t *testing.T) {
		_, err := f.insertGrant(asTenant(tenantA), grant{member: alice, tenant: tenantA, persona: "MOWN"})
		wantState(t, "duplicate tenant-wide grant", err, uniqueViolation)
		_, err = f.insertGrant(asTenant(tenantA), grant{member: bob, tenant: tenantA, merchant: merA1, persona: "MOPS"})
		wantState(t, "duplicate merchant grant", err, uniqueViolation)
		f.mustGrant(t, grant{member: alice, tenant: tenantA, environment: "LIVE", persona: "MOWN"}) // other environment
		f.mustGrant(t, grant{member: alice, tenant: tenantA, persona: "MFIN"})                      // other persona
		f.mustGrant(t, grant{member: twin, tenant: tenantA, persona: "MOWN"})                       // other issuer
	})

	t.Run("a grant cannot change", func(t *testing.T) {
		for _, set := range []string{
			"persona = 'MOWN'", "tenant_id = '" + tenantB + "'", "subject = 'someone-else'", "issuer = '" + other + "'",
			"merchant_id = NULL", "environment = 'LIVE'", "approved_by_subject = 'x'", "granted_at_utc = now()",
			"expires_at_utc = expires_at_utc + interval '1 year'", "effective_from_utc = effective_from_utc - interval '1 day'",
		} {
			_, err := f.exec(f.gw, tenantA, `UPDATE merchant.memberships SET `+set+` WHERE subject = $1`, bob.Subject)
			wantState(t, "zp_gateway SET "+set, err, insufficientPrivilege)
		}
		for _, set := range []string{"persona = 'MOWN'", "merchant_id = NULL", "approved_by_subject = 'x'",
			"expires_at_utc = expires_at_utc + interval '1 year'", "effective_from_utc = effective_from_utc - interval '1 day'"} {
			_, err := f.exec(f.mig, tenantA, `UPDATE merchant.memberships SET `+set+` WHERE subject = $1`, bob.Subject)
			wantState(t, "owner SET "+set, err, restrictViolation)
		}
	})

	t.Run("memberships are never deleted, even by the owner", func(t *testing.T) {
		_, err := f.exec(f.gw, tenantA, `DELETE FROM merchant.memberships`)
		wantState(t, "zp_gateway DELETE", err, insufficientPrivilege)
		_, err = f.exec(f.gw, tenantA, `TRUNCATE merchant.memberships`)
		wantState(t, "zp_gateway TRUNCATE", err, insufficientPrivilege)
		_, err = f.exec(f.mig, tenantA, `DELETE FROM merchant.memberships WHERE subject = $1`, bob.Subject)
		wantState(t, "owner DELETE", err, restrictViolation)
		_, err = f.exec(f.mig, "", `TRUNCATE merchant.memberships`)
		wantState(t, "owner TRUNCATE", err, restrictViolation)
	})

	t.Run("the runtime role cannot weaken the policies", func(t *testing.T) {
		for _, stmt := range []string{
			`DROP POLICY own_active_memberships ON merchant.memberships`,
			`DROP POLICY tenant_isolation ON merchant.memberships`,
			`CREATE POLICY see_all ON merchant.memberships FOR SELECT USING (true)`,
			`ALTER TABLE merchant.memberships NO FORCE ROW LEVEL SECURITY`,
			`DROP TRIGGER membership_guard ON merchant.memberships`,
		} {
			_, err := f.exec(f.gw, "", stmt)
			wantState(t, "zp_gateway: "+stmt, err, insufficientPrivilege)
		}
	})

	t.Run("other deployables' roles cannot read memberships", func(t *testing.T) {
		for _, role := range []string{"zp_execution", "zp_finance", "zp_governance", "zp_relay"} {
			_, err := f.execAs(f.pg.Pool(t, role), asBoth(tenantA, alice), `SELECT 1 FROM merchant.memberships`)
			wantState(t, role, err, insufficientPrivilege)
		}
	})

	t.Run("issuer and subject are format-checked", func(t *testing.T) {
		for what, member := range map[string]db.Subject{
			"issuer that is not a URL": {Issuer: "zoikopay", Subject: "s1"},
			"issuer with a space":      {Issuer: "http://localhost:8180/realms/zoiko pay", Subject: "s1"},
			"empty subject":            {Issuer: keycloak, Subject: ""},
			"subject longer than 255":  {Issuer: keycloak, Subject: strings.Repeat("s", 256)},
			"subject with a space":     {Issuer: keycloak, Subject: "two words"},
		} {
			_, err := f.insertGrant(asTenant(tenantA), grant{member: member, tenant: tenantA, persona: "MVIEW"})
			wantState(t, what, err, checkViolation)
		}
	})
}
