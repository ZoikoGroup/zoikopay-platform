//go:build integration

package store_test

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/ids"
)

// Grant administration in the database (OPEN_QUESTIONS Q40): invitations,
// access requests and grants made from them. For every role except the
// provisioning role (the database superuser, standing in for 05-03 tenant
// provisioning), the database itself enforces maker ≠ checker ≠ member,
// "never grant above the delegator" (Q36 36.12, 36.15), single-use expiring
// invitations (36.10) and covering-owner revocation; every change leaves an
// append-only grant event (03-05 §14 GrantChanged).

const (
	insertInvitation = `INSERT INTO merchant.invitations
		(invitation_id, tenant_id, environment, token_hash, invited_by_issuer, invited_by_subject, expires_at_utc)
		VALUES ($1, $2, 'TEST', $3, $4, $5, now() + $6::interval)`
	acceptInvitation = `UPDATE merchant.invitations SET accepted_by_issuer = $2, accepted_by_subject = $3, accepted_at_utc = now()
		WHERE token_hash = $1`
	insertRequest = `INSERT INTO merchant.access_requests
		(access_request_id, tenant_id, environment, member_issuer, member_subject, merchant_id, persona,
		 effective_from_utc, expires_at_utc, purpose, requested_by_issuer, requested_by_subject, decision_due_at_utc)
		VALUES ($1, $2, 'TEST', $3, $4, $5, $6, now(), now() + $7::interval, 'joining the payments team', $8, $9, now() + $10::interval)
		RETURNING id::text`
	decideRequest = `UPDATE merchant.access_requests
		SET status = $2, decided_by_issuer = $3, decided_by_subject = $4, decided_at_utc = now(), decision_reason = $5, version = version + 1
		WHERE id = $1::uuid`
	// grantFrom copies an approved request into a grant, with optional overrides.
	grantFrom = `INSERT INTO merchant.memberships
		(id, issuer, subject, tenant_id, merchant_id, environment, persona, granted_by_issuer, granted_by_subject,
		 approved_by_issuer, approved_by_subject, granted_at_utc, effective_from_utc, expires_at_utc, access_request_id)
		SELECT uuidv7(), r.member_issuer, coalesce($2, r.member_subject), r.tenant_id,
		       CASE WHEN $3::text = '' THEN NULL ELSE coalesce($3, r.merchant_id) END, r.environment,
		       coalesce($4, r.persona), r.requested_by_issuer, coalesce($5, r.requested_by_subject),
		       r.decided_by_issuer, coalesce($6, r.decided_by_subject), now(), greatest(r.effective_from_utc, now()),
		       r.expires_at_utc + coalesce($7::interval, interval '0'), CASE WHEN $8::boolean THEN NULL ELSE r.id END
		FROM merchant.access_requests r WHERE r.id = $1::uuid
		RETURNING id::text`
	revokeNow = `UPDATE merchant.memberships SET revoked_at_utc = now(), revoked_by_issuer = $2, revoked_by_subject = $3
		WHERE id = $1::uuid`
)

// override changes one field of grantFrom's copy; the zero value copies exactly.
type override struct {
	subject, merchant, persona, maker, checker *string
	extend                                     *string // interval added to expires_at
	noRequest                                  bool
}

func ptr(s string) *string { return &s }

func newToken(t *testing.T) (hexHash string, hash []byte) {
	t.Helper()
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:]), h[:]
}

func (f *fixture) queryID(p *pgxpool.Pool, a access, sql string, args ...any) (string, error) {
	var id string
	err := f.run(p, a, func(q db.DBTX) error { return q.QueryRow(f.ctx, sql, args...).Scan(&id) })
	return id, err
}

func (f *fixture) request(t *testing.T, tenant string, member, by db.Subject, merchant any, persona, lasts string) (string, error) {
	t.Helper()
	return f.queryID(f.gw, asTenant(tenant), insertRequest, ids.NewPublic(ids.AccessRequest), tenant, member.Issuer, member.Subject,
		merchant, persona, lasts, by.Issuer, by.Subject, "1 hour")
}

func (f *fixture) mustRequest(t *testing.T, tenant string, member, by db.Subject, merchant any, persona string) string {
	t.Helper()
	id, err := f.request(t, tenant, member, by, merchant, persona, "7 days")
	if err != nil {
		t.Fatalf("request %s for %s by %s: %v", persona, member.Subject, by.Subject, err)
	}
	return id
}

func (f *fixture) decide(tenant, request, status string, by db.Subject, reason any) (int64, error) {
	return f.exec(f.gw, tenant, decideRequest, request, status, by.Issuer, by.Subject, reason)
}

func (f *fixture) grantFromRequest(tenant, request string, o override) (string, error) {
	return f.queryID(f.gw, asTenant(tenant), grantFrom, request, o.subject, o.merchant, o.persona, o.maker, o.checker, o.extend, o.noRequest)
}

func TestGrantAdministration(t *testing.T) {
	f := setup(t)
	tenantA := f.newTenant(t, "Synthetic Tenant A")
	tenantB := f.newTenant(t, "Synthetic Tenant B")
	merA1 := f.newMerchant(t, tenantA, "A One")
	merA2 := f.newMerchant(t, tenantA, "A Two")
	f.newMerchant(t, tenantB, "B One")

	sub := func(s string) db.Subject {
		return db.Subject{Issuer: keycloak, Subject: "00000000-0000-4000-8000-" + s}
	}
	var (
		ownerA     = sub("0000000000f1") // MOWN, all of tenant A
		ownerB     = sub("0000000000f2") // MOWN, all of tenant A: the independent checker
		ownerM1    = sub("0000000000f3") // MOWN, merchant A1 only
		shortOwner = sub("0000000000f4") // MOWN, all of tenant A, expires in 2 days
		ownerOfB   = sub("0000000000f5") // MOWN, tenant B
		erin       = sub("00000000e212") // MVIEW on A1, not an owner
		dave       = sub("00000000da7e") // invited to tenant A
		stranger   = sub("00000000057a") // unknown to tenant A
	)
	month := time.Now().UTC().Add(30 * 24 * time.Hour)
	f.mustGrant(t, grant{member: ownerA, tenant: tenantA, persona: "MOWN", expiresAt: month})
	ownerBGrant := f.mustGrant(t, grant{member: ownerB, tenant: tenantA, persona: "MOWN", expiresAt: month})
	f.mustGrant(t, grant{member: ownerM1, tenant: tenantA, merchant: merA1, persona: "MOWN", expiresAt: month})
	f.mustGrant(t, grant{member: shortOwner, tenant: tenantA, persona: "MOWN", expiresAt: time.Now().UTC().Add(48 * time.Hour)})
	f.mustGrant(t, grant{member: ownerOfB, tenant: tenantB, persona: "MOWN", expiresAt: month})
	f.mustGrant(t, grant{member: erin, tenant: tenantA, merchant: merA1, persona: "MVIEW", expiresAt: month})

	invite := func(tenant string, by db.Subject, hash []byte, lasts string) error {
		_, err := f.exec(f.gw, tenant, insertInvitation, ids.NewPublic(ids.Invitation), tenant, hash, by.Issuer, by.Subject, lasts)
		return err
	}
	daveHex, daveHash := newToken(t)

	t.Run("an invitation stores only a 32-byte token hash", func(t *testing.T) {
		if err := invite(tenantA, ownerA, []byte("too-short-to-be-a-hash"), "1 hour"); err == nil {
			t.Fatal("a non-hash token was stored")
		} else {
			wantState(t, "short token", err, checkViolation)
		}
	})

	t.Run("only an owner of the tenant can invite", func(t *testing.T) {
		_, h := newToken(t)
		wantState(t, "MVIEW invites", invite(tenantA, erin, h, "1 hour"), insufficientPrivilege)
		wantState(t, "tenant B's owner invites to A", invite(tenantA, ownerOfB, h, "1 hour"), insufficientPrivilege)
		wantState(t, "stranger invites", invite(tenantA, stranger, h, "1 hour"), insufficientPrivilege)
		if err := invite(tenantA, ownerM1, h, "1 hour"); err != nil {
			t.Errorf("a merchant-scoped owner invites to the tenant: %v", err)
		}
		if err := invite(tenantA, ownerA, daveHash, "1 hour"); err != nil {
			t.Fatalf("owner invites dave: %v", err)
		}
	})

	t.Run("the token finds exactly its own invitation and nothing else", func(t *testing.T) {
		otherHex, _ := newToken(t)
		for what, c := range map[string]struct {
			a    access
			want int
		}{
			"dave's token":     {asToken(daveHex), 1},
			"an unknown token": {asToken(otherHex), 0},
			"a malformed hash": {asToken("not-hex"), 0},
			"no context":       {access{}, 0},
			"tenant B":         {asTenant(tenantB), 0},
			"tenant A":         {asTenant(tenantA), 2},
		} {
			if n := f.countAs(t, f.gw, c.a, `SELECT count(*) FROM merchant.invitations`); n != c.want {
				t.Errorf("%s sees %d invitations, want %d", what, n, c.want)
			}
		}
		for _, table := range []string{"memberships", "access_requests", "grant_events"} {
			if n := f.countAs(t, f.gw, asToken(daveHex), `SELECT count(*) FROM merchant.`+table); n != 0 {
				t.Errorf("a token context sees %d rows of %s", n, table)
			}
		}
	})

	t.Run("an invitation is accepted once, by someone other than the inviter, before it expires", func(t *testing.T) {
		_, err := f.execAs(f.gw, asToken(daveHex), acceptInvitation, daveHash, ownerA.Issuer, ownerA.Subject)
		wantState(t, "the inviter accepts", err, checkViolation)
		if n, err := f.execAs(f.gw, asToken(daveHex), acceptInvitation, daveHash, dave.Issuer, dave.Subject); err != nil || n != 1 {
			t.Fatalf("dave accepts: %d rows, %v", n, err)
		}
		_, err = f.execAs(f.gw, asToken(daveHex), acceptInvitation, daveHash, stranger.Issuer, stranger.Subject)
		wantState(t, "a second acceptance (replay)", err, restrictViolation)

		shortHex, shortHash := newToken(t)
		if err := invite(tenantA, ownerA, shortHash, "1 second"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(1200 * time.Millisecond)
		_, err = f.execAs(f.gw, asToken(shortHex), acceptInvitation, shortHash, stranger.Issuer, stranger.Subject)
		wantState(t, "an expired invitation", err, restrictViolation)

		for _, set := range []string{"tenant_id = '" + tenantB + "'", "expires_at_utc = expires_at_utc + interval '1 day'", "token_hash = sha256(token_hash)"} {
			_, err := f.exec(f.gw, tenantA, `UPDATE merchant.invitations SET `+set)
			wantState(t, "zp_gateway SET "+set, err, insufficientPrivilege)
			_, err = f.exec(f.mig, tenantA, `UPDATE merchant.invitations SET `+set)
			wantState(t, "owner SET "+set, err, restrictViolation)
		}
		_, err = f.exec(f.gw, tenantA, `DELETE FROM merchant.invitations`)
		wantState(t, "zp_gateway DELETE", err, insufficientPrivilege)
		_, err = f.exec(f.mig, tenantA, `DELETE FROM merchant.invitations`)
		wantState(t, "owner DELETE", err, restrictViolation)
	})

	t.Run("a request needs a maker whose owner grant covers it", func(t *testing.T) {
		for what, c := range map[string]struct {
			by       db.Subject
			merchant any
			lasts    string
		}{
			"an MVIEW maker":                         {erin, merA1, "7 days"},
			"another tenant's owner":                 {ownerOfB, merA1, "7 days"},
			"a merchant owner asking tenant-wide":    {ownerM1, nil, "7 days"},
			"a merchant owner asking for another":    {ownerM1, merA2, "7 days"},
			"longer than the maker's own owner role": {shortOwner, merA1, "7 days"},
		} {
			_, err := f.request(t, tenantA, dave, c.by, c.merchant, "MVIEW", c.lasts)
			wantState(t, what, err, insufficientPrivilege)
		}
		_, err := f.request(t, tenantA, stranger, ownerA, merA1, "MVIEW", "7 days")
		wantState(t, "for a person who never accepted an invitation and holds no grant", err, insufficientPrivilege)
		_, err = f.request(t, tenantA, dave, ownerA, merA1, "MOWN", "7 days")
		wantState(t, "an owner role", err, checkViolation)
		_, err = f.request(t, tenantA, ownerB, ownerB, merA1, "MVIEW", "7 days")
		wantState(t, "the maker for themselves", err, checkViolation)
		f.mustRequest(t, tenantA, dave, ownerM1, merA1, "MVIEW") // merchant owner, own merchant
		f.mustRequest(t, tenantA, erin, ownerA, nil, "MFIN")     // an existing member, tenant-wide
	})

	t.Run("a decision needs an independent owner who covers the request", func(t *testing.T) {
		req := f.mustRequest(t, tenantA, dave, ownerA, nil, "MOPS")
		_, err := f.decide(tenantA, req, "APPROVED", ownerA, nil)
		wantState(t, "the maker approves", err, checkViolation)
		_, err = f.decide(tenantA, req, "APPROVED", erin, nil)
		wantState(t, "a non-owner approves", err, insufficientPrivilege)
		_, err = f.decide(tenantA, req, "APPROVED", ownerM1, nil)
		wantState(t, "a merchant owner approves a tenant-wide request", err, insufficientPrivilege)
		_, err = f.decide(tenantA, req, "APPROVED", shortOwner, nil)
		wantState(t, "an owner whose own role ends sooner", err, insufficientPrivilege)
		_, err = f.decide(tenantA, req, "REJECTED", ownerB, nil)
		wantState(t, "a rejection without a reason", err, checkViolation)

		self := f.mustRequest(t, tenantA, ownerB, ownerA, merA1, "MVIEW")
		_, err = f.decide(tenantA, self, "APPROVED", ownerB, nil)
		wantState(t, "the member approves their own role", err, checkViolation)

		if n, err := f.decide(tenantA, req, "APPROVED", ownerB, nil); err != nil || n != 1 {
			t.Fatalf("independent approval: %d rows, %v", n, err)
		}
		_, err = f.decide(tenantA, req, "REJECTED", ownerB, "changed my mind")
		wantState(t, "deciding twice", err, restrictViolation)
		_, err = f.exec(f.gw, tenantA, `UPDATE merchant.access_requests SET version = version + 2, status = 'REJECTED', decided_by_issuer = $2, decided_by_subject = $3, decided_at_utc = now(), decision_reason = 'x' WHERE id = $1::uuid`,
			self, ownerA.Issuer, ownerA.Subject)
		wantState(t, "a version jump", err, restrictViolation)
		_, err = f.exec(f.gw, tenantA, `UPDATE merchant.access_requests SET persona = 'MFIN' WHERE id = $1::uuid`, self)
		wantState(t, "zp_gateway changes the persona", err, insufficientPrivilege)
		_, err = f.exec(f.mig, tenantA, `UPDATE merchant.access_requests SET persona = 'MFIN' WHERE id = $1::uuid`, self)
		wantState(t, "owner changes the persona", err, restrictViolation)
		if n, err := f.decide(tenantA, self, "REJECTED", ownerA, "withdrawn by the maker"); err != nil || n != 1 {
			t.Errorf("the maker withdraws (rejects) their own request: %d rows, %v", n, err)
		}

		lapsing, err := f.queryID(f.gw, asTenant(tenantA), insertRequest, ids.NewPublic(ids.AccessRequest), tenantA, dave.Issuer, dave.Subject,
			merA1, "MDEV", "7 days", ownerA.Issuer, ownerA.Subject, "1 second")
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(1200 * time.Millisecond)
		_, err = f.decide(tenantA, lapsing, "APPROVED", ownerB, nil)
		wantState(t, "approving a lapsed request", err, restrictViolation)
		_, err = f.exec(f.gw, tenantA, `DELETE FROM merchant.access_requests`)
		wantState(t, "zp_gateway DELETE", err, insufficientPrivilege)
	})

	t.Run("the runtime role creates a grant only from an approved request that matches it", func(t *testing.T) {
		pending := f.mustRequest(t, tenantA, dave, ownerA, merA2, "MVIEW")
		_, err := f.grantFromRequest(tenantA, pending, override{})
		wantState(t, "from a request still awaiting approval", err, insufficientPrivilege)

		rejected := f.mustRequest(t, tenantA, dave, ownerA, merA2, "MFIN")
		if _, err := f.decide(tenantA, rejected, "REJECTED", ownerB, "not needed"); err != nil {
			t.Fatal(err)
		}
		_, err = f.grantFromRequest(tenantA, rejected, override{})
		wantState(t, "from a rejected request", err, insufficientPrivilege)

		approved := f.mustRequest(t, tenantA, dave, ownerA, merA1, "MDEV")
		if _, err := f.decide(tenantA, approved, "APPROVED", ownerB, nil); err != nil {
			t.Fatal(err)
		}
		for what, o := range map[string]override{
			"without a request":   {noRequest: true},
			"another member":      {subject: ptr(stranger.Subject)},
			"another merchant":    {merchant: ptr(merA2)},
			"tenant-wide instead": {merchant: ptr("")},
			"another persona":     {persona: ptr("MFIN")},
			"an owner role":       {persona: ptr("MOWN")},
			"another maker":       {maker: ptr(ownerM1.Subject)},
			"another checker":     {checker: ptr(shortOwner.Subject)},
			"a longer grant":      {extend: ptr("1 day")},
		} {
			_, err := f.grantFromRequest(tenantA, approved, o)
			wantState(t, what, err, insufficientPrivilege)
		}
		daveGrant, err := f.grantFromRequest(tenantA, approved, override{})
		if err != nil {
			t.Fatalf("grant from the approved request: %v", err)
		}
		_, err = f.grantFromRequest(tenantA, approved, override{})
		wantState(t, "a second grant from the same request", err, uniqueViolation)
		if n := f.countAs(t, f.gw, asSubject(dave), `SELECT count(*) FROM merchant.memberships`); n != 1 {
			t.Errorf("dave holds %d live grants, want 1", n)
		}

		// The checker's own owner role is revoked after approving: the grant is refused.
		late := f.mustRequest(t, tenantA, dave, ownerA, merA2, "MOPS")
		if _, err := f.decide(tenantA, late, "APPROVED", ownerB, nil); err != nil {
			t.Fatal(err)
		}
		if _, err := f.exec(f.prov, tenantA, revokeNow, ownerBGrant, ownerA.Issuer, ownerA.Subject); err != nil {
			t.Fatal(err)
		}
		_, err = f.grantFromRequest(tenantA, late, override{})
		wantState(t, "the checker no longer holds an owner role", err, insufficientPrivilege)

		t.Run("revocation needs an owner whose grant covers it", func(t *testing.T) {
			_, err := f.exec(f.gw, tenantA, revokeNow, daveGrant, erin.Issuer, erin.Subject)
			wantState(t, "revoked by a non-owner", err, insufficientPrivilege)
			ownerGrant := f.mustGrant(t, grant{member: sub("0000000000f6"), tenant: tenantA, persona: "MOWN", expiresAt: month})
			_, err = f.exec(f.gw, tenantA, revokeNow, ownerGrant, ownerA.Issuer, ownerA.Subject)
			wantState(t, "an owner role revoked at runtime", err, insufficientPrivilege)
			if n, err := f.exec(f.gw, tenantA, revokeNow, daveGrant, ownerM1.Issuer, ownerM1.Subject); err != nil || n != 1 {
				t.Fatalf("the owner of merchant A1 revokes dave's A1 grant: %d rows, %v", n, err)
			}
			if n := f.countAs(t, f.gw, asSubject(dave), `SELECT count(*) FROM merchant.memberships`); n != 0 {
				t.Errorf("dave still holds %d live grants after revocation", n)
			}
		})
	})

	t.Run("every change leaves an append-only grant event the runtime role cannot forge", func(t *testing.T) {
		var got map[string]int
		rows, err := f.prov.Query(f.ctx, `SELECT event_type, count(*) FROM merchant.grant_events WHERE tenant_id = $1 GROUP BY 1`, tenantA)
		if err != nil {
			t.Fatal(err)
		}
		got = map[string]int{}
		for rows.Next() {
			var k string
			var n int
			if err := rows.Scan(&k, &n); err != nil {
				t.Fatal(err)
			}
			got[k] = n
		}
		rows.Close()
		for _, k := range []string{"INVITATION_CREATED", "INVITATION_ACCEPTED", "ACCESS_REQUESTED", "ACCESS_APPROVED", "ACCESS_REJECTED", "GRANT_CREATED", "GRANT_REVOKED"} {
			if got[k] == 0 {
				t.Errorf("no %s event (events: %v)", k, got)
			}
		}
		var actor string
		if err := f.prov.QueryRow(f.ctx, `SELECT actor_subject FROM merchant.grant_events
			WHERE event_type = 'INVITATION_ACCEPTED' AND tenant_id = $1`, tenantA).Scan(&actor); err != nil || actor != dave.Subject {
			t.Errorf("acceptance event actor %q (%v); want dave", actor, err)
		}
		var maker, approver string
		if err := f.prov.QueryRow(f.ctx, `SELECT maker_subject, approver_subject FROM merchant.grant_events
			WHERE event_type = 'GRANT_CREATED' AND member_subject = $1`, dave.Subject).Scan(&maker, &approver); err != nil || maker != ownerA.Subject || approver != ownerB.Subject {
			t.Errorf("grant event maker %q approver %q (%v); want ownerA and ownerB", maker, approver, err)
		}
		_, err = f.exec(f.gw, tenantA, `INSERT INTO merchant.grant_events (tenant_id, environment, event_type, actor_issuer, actor_subject) VALUES ($1, 'TEST', 'GRANT_CREATED', $2, $3)`,
			tenantA, ownerA.Issuer, ownerA.Subject)
		wantState(t, "zp_gateway forges an event", err, insufficientPrivilege)
		for _, stmt := range []string{`UPDATE merchant.grant_events SET actor_subject = 'x'`, `DELETE FROM merchant.grant_events`} {
			_, err := f.exec(f.gw, tenantA, stmt)
			wantState(t, "zp_gateway: "+stmt, err, insufficientPrivilege)
			_, err = f.exec(f.mig, tenantA, stmt)
			wantState(t, "owner: "+stmt, err, restrictViolation)
			_, err = f.exec(f.prov, tenantA, stmt)
			wantState(t, "superuser: "+stmt, err, restrictViolation)
		}
		_, err = f.exec(f.prov, "", `TRUNCATE merchant.grant_events`)
		wantState(t, "superuser TRUNCATE", err, restrictViolation)
		if n := f.count(t, f.gw, tenantB, `SELECT count(*) FROM merchant.grant_events WHERE tenant_id <> $1`, tenantB); n != 0 {
			t.Errorf("tenant B sees %d grant events of other tenants", n)
		}
	})

	t.Run("the new tables are tenant-isolated and closed to other roles", func(t *testing.T) {
		for _, table := range []string{"invitations", "access_requests", "grant_events"} {
			if n := f.count(t, f.gw, tenantB, `SELECT count(*) FROM merchant.`+table+` WHERE tenant_id = $1`, tenantA); n != 0 {
				t.Errorf("tenant B sees %d of tenant A's %s", n, table)
			}
			if n := f.count(t, f.gw, "", `SELECT count(*) FROM merchant.`+table); n != 0 {
				t.Errorf("no context sees %d %s", n, table)
			}
			for _, role := range []string{"zp_execution", "zp_finance", "zp_governance", "zp_relay", "zp_audit"} {
				_, err := f.execAs(f.pg.Pool(t, role), asTenant(tenantA), `SELECT 1 FROM merchant.`+table)
				wantState(t, role+" reads "+table, err, insufficientPrivilege)
			}
		}
		for _, stmt := range []string{`ALTER TABLE merchant.invitations NO FORCE ROW LEVEL SECURITY`,
			`DROP POLICY tenant_isolation ON merchant.access_requests`, `DROP TRIGGER membership_delegation ON merchant.memberships`} {
			_, err := f.exec(f.gw, "", stmt)
			wantState(t, "zp_gateway: "+stmt, err, insufficientPrivilege)
		}
	})

	t.Run("every grant has a public ID", func(t *testing.T) {
		format := regexp.MustCompile(`^mbr_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$`)
		rows, err := f.prov.Query(f.ctx, `SELECT membership_id FROM merchant.memberships`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		seen := map[string]bool{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			if !format.MatchString(id) || seen[id] {
				t.Errorf("membership_id %q malformed or repeated", id)
			}
			seen[id] = true
		}
		if len(seen) == 0 {
			t.Error("no memberships checked")
		}
	})
}
