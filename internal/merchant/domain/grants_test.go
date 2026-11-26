package domain_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/zoiko/zoikopay/internal/merchant/domain"
)

var (
	now     = time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	month   = now.Add(30 * 24 * time.Hour)
	week    = now.Add(7 * 24 * time.Hour)
	issuer  = "http://localhost:8180/realms/zoikopay"
	ownerA  = domain.Person{Issuer: issuer, Subject: "owner-a"}
	ownerB  = domain.Person{Issuer: issuer, Subject: "owner-b"}
	member  = domain.Person{Issuer: issuer, Subject: "member"}
	tenant  = "ten_a"
	merA1   = "mer_a1"
	merA2   = "mer_a2"
	wide    = domain.OwnerGrant{TenantID: tenant, ExpiresAt: month}
	scopedA = domain.OwnerGrant{TenantID: tenant, MerchantID: merA1, ExpiresAt: month}
)

func draft(edit ...func(*domain.RequestDraft)) domain.RequestDraft {
	d := domain.RequestDraft{Member: member, Maker: ownerA, Scope: domain.Scope{TenantID: tenant, MerchantID: merA1},
		Persona: domain.MVIEW, EffectiveFrom: now, ExpiresAt: week, Purpose: "joining the payments team"}
	for _, e := range edit {
		e(&d)
	}
	return d
}

func pending(edit ...func(*domain.RequestState)) domain.RequestState {
	r := domain.RequestState{Status: domain.Awaiting, Maker: ownerA, Member: member,
		Scope: domain.Scope{TenantID: tenant, MerchantID: merA1}, Persona: domain.MVIEW,
		EffectiveFrom: now, ExpiresAt: week, DecisionDue: now.Add(time.Hour), Version: 1}
	for _, e := range edit {
		e(&r)
	}
	return r
}

func TestOwnerCoverage(t *testing.T) {
	for what, c := range map[string]struct {
		owner domain.OwnerGrant
		scope domain.Scope
		want  bool
	}{
		"tenant-wide owner, one merchant":      {wide, domain.Scope{TenantID: tenant, MerchantID: merA1}, true},
		"tenant-wide owner, tenant-wide grant": {wide, domain.Scope{TenantID: tenant}, true},
		"merchant owner, own merchant":         {scopedA, domain.Scope{TenantID: tenant, MerchantID: merA1}, true},
		"merchant owner, sibling merchant":     {scopedA, domain.Scope{TenantID: tenant, MerchantID: merA2}, false},
		"merchant owner, tenant-wide grant":    {scopedA, domain.Scope{TenantID: tenant}, false},
		"another tenant":                       {wide, domain.Scope{TenantID: "ten_b", MerchantID: merA1}, false},
	} {
		if got := c.owner.Covers(c.scope); got != c.want {
			t.Errorf("%s: Covers = %v, want %v", what, got, c.want)
		}
	}
	short := domain.OwnerGrant{TenantID: tenant, ExpiresAt: now.Add(24 * time.Hour)}
	if domain.Delegates([]domain.OwnerGrant{short}, domain.Scope{TenantID: tenant}, week) {
		t.Error("an owner grant ending sooner delegates a longer role (above the delegator)")
	}
	if !domain.Delegates([]domain.OwnerGrant{short, wide}, domain.Scope{TenantID: tenant}, week) {
		t.Error("a long enough owner grant among several does not delegate")
	}
	if domain.Delegates(nil, domain.Scope{TenantID: tenant}, week) {
		t.Error("no owner grant delegates (deny by default)")
	}
}

func TestCheckRequest(t *testing.T) {
	owners := []domain.OwnerGrant{wide}
	if err := domain.CheckRequest(draft(), owners, now); err != nil {
		t.Fatalf("a valid request: %v", err)
	}
	for what, c := range map[string]struct {
		d      domain.RequestDraft
		owners []domain.OwnerGrant
		want   error
	}{
		"an owner role":                    {draft(func(d *domain.RequestDraft) { d.Persona = domain.MOWN }), owners, domain.ErrNotDelegable},
		"an unknown persona":               {draft(func(d *domain.RequestDraft) { d.Persona = "SUPER_ADMIN" }), owners, domain.ErrNotDelegable},
		"the maker for themselves":         {draft(func(d *domain.RequestDraft) { d.Member = ownerA }), owners, domain.ErrSoD},
		"a maker who is no owner":          {draft(), nil, domain.ErrExceedsDelegator},
		"outlasting the maker's own grant": {draft(func(d *domain.RequestDraft) { d.ExpiresAt = month.Add(time.Hour) }), owners, domain.ErrExceedsDelegator},
		"a merchant owner, tenant-wide":    {draft(func(d *domain.RequestDraft) { d.Scope.MerchantID = "" }), []domain.OwnerGrant{scopedA}, domain.ErrExceedsDelegator},
		"a merchant owner, sibling":        {draft(func(d *domain.RequestDraft) { d.Scope.MerchantID = merA2 }), []domain.OwnerGrant{scopedA}, domain.ErrExceedsDelegator},
		"ending before it starts":          {draft(func(d *domain.RequestDraft) { d.ExpiresAt = d.EffectiveFrom }), owners, domain.ErrWindow},
		"already over": {draft(func(d *domain.RequestDraft) {
			d.EffectiveFrom, d.ExpiresAt = now.Add(-2*time.Hour), now.Add(-time.Hour)
		}), owners, domain.ErrWindow},
		"starting long ago":             {draft(func(d *domain.RequestDraft) { d.EffectiveFrom = now.Add(-time.Hour) }), owners, domain.ErrWindow},
		"no purpose":                    {draft(func(d *domain.RequestDraft) { d.Purpose = "   " }), owners, domain.ErrPurpose},
		"a purpose over 200 characters": {draft(func(d *domain.RequestDraft) { d.Purpose = strings.Repeat("x", 201) }), owners, domain.ErrPurpose},
		"a token pasted as purpose":     {draft(func(d *domain.RequestDraft) { d.Purpose = "eyJhbGciOiJSUzI1NiJ9.x.y" }), owners, domain.ErrPurpose},
	} {
		if err := domain.CheckRequest(c.d, c.owners, now); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", what, err, c.want)
		}
	}
	if err := domain.CheckRequest(draft(func(d *domain.RequestDraft) { d.EffectiveFrom = now.Add(-time.Minute) }), owners, now); err != nil {
		t.Errorf("a start a minute ago (clock skew) is refused: %v", err)
	}
}

func TestCheckApproval(t *testing.T) {
	checkers := []domain.OwnerGrant{wide}
	makers := []domain.OwnerGrant{wide}
	if err := domain.CheckApproval(pending(), ownerB, checkers, makers, 1, now); err != nil {
		t.Fatalf("an independent approval: %v", err)
	}
	for what, c := range map[string]struct {
		r        domain.RequestState
		checker  domain.Person
		checkers []domain.OwnerGrant
		makers   []domain.OwnerGrant
		version  int64
		want     error
	}{
		"the maker approves":                  {pending(), ownerA, checkers, makers, 1, domain.ErrSoD},
		"the member approves":                 {pending(func(r *domain.RequestState) { r.Member = ownerB }), ownerB, checkers, makers, 1, domain.ErrSoD},
		"a checker who is no owner":           {pending(), ownerB, nil, makers, 1, domain.ErrExceedsDelegator},
		"a checker whose grant ends sooner":   {pending(), ownerB, []domain.OwnerGrant{{TenantID: tenant, ExpiresAt: now.Add(time.Hour)}}, makers, 1, domain.ErrExceedsDelegator},
		"a merchant owner, tenant-wide grant": {pending(func(r *domain.RequestState) { r.Scope.MerchantID = "" }), ownerB, []domain.OwnerGrant{scopedA}, makers, 1, domain.ErrExceedsDelegator},
		"the maker lost their owner role":     {pending(), ownerB, checkers, nil, 1, domain.ErrExceedsDelegator},
		"a stale version":                     {pending(), ownerB, checkers, makers, 0, domain.ErrVersion},
		"already approved":                    {pending(func(r *domain.RequestState) { r.Status = domain.Approved }), ownerB, checkers, makers, 1, domain.ErrNotPending},
		"already rejected":                    {pending(func(r *domain.RequestState) { r.Status = domain.Rejected }), ownerB, checkers, makers, 1, domain.ErrNotPending},
		"past its decision date":              {pending(func(r *domain.RequestState) { r.DecisionDue = now }), ownerB, checkers, makers, 1, domain.ErrExpired},
		"the role would already be over":      {pending(func(r *domain.RequestState) { r.ExpiresAt = now }), ownerB, checkers, makers, 1, domain.ErrWindow},
	} {
		if err := domain.CheckApproval(c.r, c.checker, c.checkers, c.makers, c.version, now); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", what, err, c.want)
		}
	}
}

func TestCheckRejection(t *testing.T) {
	owners := []domain.OwnerGrant{wide}
	if err := domain.CheckRejection(pending(), ownerB, owners, 1, "not needed", now); err != nil {
		t.Fatalf("a rejection: %v", err)
	}
	if err := domain.CheckRejection(pending(), ownerA, owners, 1, "withdrawn", now); err != nil {
		t.Errorf("the maker withdraws their own request: %v", err)
	}
	for what, c := range map[string]struct {
		r       domain.RequestState
		by      domain.Person
		owners  []domain.OwnerGrant
		version int64
		reason  string
		want    error
	}{
		"the member rejects":     {pending(func(r *domain.RequestState) { r.Member = ownerB }), ownerB, owners, 1, "x", domain.ErrSoD},
		"no reason":              {pending(), ownerB, owners, 1, " ", domain.ErrPurpose},
		"a non-owner rejects":    {pending(), ownerB, nil, 1, "x", domain.ErrExceedsDelegator},
		"a stale version":        {pending(), ownerB, owners, 2, "x", domain.ErrVersion},
		"already decided":        {pending(func(r *domain.RequestState) { r.Status = domain.Approved }), ownerB, owners, 1, "x", domain.ErrNotPending},
		"past its decision date": {pending(func(r *domain.RequestState) { r.DecisionDue = now.Add(-time.Second) }), ownerB, owners, 1, "x", domain.ErrExpired},
	} {
		if err := domain.CheckRejection(c.r, c.by, c.owners, c.version, c.reason, now); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", what, err, c.want)
		}
	}
}

func TestRequestStatusAndGrantWindow(t *testing.T) {
	if s := pending().StatusAt(now); s != domain.Awaiting {
		t.Errorf("status %s, want awaiting", s)
	}
	if s := pending().StatusAt(now.Add(time.Hour)); s != domain.Expired {
		t.Errorf("status at the decision date %s, want expired", s)
	}
	if s := pending(func(r *domain.RequestState) { r.Status = domain.Approved }).StatusAt(now.Add(2 * time.Hour)); s != domain.Approved {
		t.Errorf("a decided request reports %s after the decision date, want approved", s)
	}
	from, until := pending(func(r *domain.RequestState) { r.EffectiveFrom = now.Add(-time.Minute) }).GrantWindow(now)
	if !from.Equal(now) || !until.Equal(week) {
		t.Errorf("grant window %v–%v; want it to start at approval and end with the request", from, until)
	}
	from, _ = pending(func(r *domain.RequestState) { r.EffectiveFrom = now.Add(time.Hour) }).GrantWindow(now)
	if !from.Equal(now.Add(time.Hour)) {
		t.Errorf("a future start moved to %v", from)
	}
}

func TestCheckRevocation(t *testing.T) {
	owners := []domain.OwnerGrant{scopedA}
	target := domain.GrantState{Persona: domain.MVIEW, Scope: domain.Scope{TenantID: tenant, MerchantID: merA1}}
	if err := domain.CheckRevocation(target, owners); err != nil {
		t.Fatalf("a covering owner revokes: %v", err)
	}
	for what, c := range map[string]struct {
		g      domain.GrantState
		owners []domain.OwnerGrant
		want   error
	}{
		"an owner grant":          {domain.GrantState{Persona: domain.MOWN, Scope: target.Scope}, []domain.OwnerGrant{wide}, domain.ErrNotDelegable},
		"a sibling merchant":      {domain.GrantState{Persona: domain.MVIEW, Scope: domain.Scope{TenantID: tenant, MerchantID: merA2}}, owners, domain.ErrExceedsDelegator},
		"a tenant-wide grant":     {domain.GrantState{Persona: domain.MVIEW, Scope: domain.Scope{TenantID: tenant}}, owners, domain.ErrExceedsDelegator},
		"by someone not an owner": {target, nil, domain.ErrExceedsDelegator},
		"already revoked":         {domain.GrantState{Persona: domain.MVIEW, Scope: target.Scope, Revoked: true}, owners, domain.ErrNotPending},
	} {
		if err := domain.CheckRevocation(c.g, c.owners); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", what, err, c.want)
		}
	}
}

func TestInvitations(t *testing.T) {
	if s := domain.InvitationStatusAt(now.Add(time.Hour), false, now); s != domain.InvitationPending {
		t.Errorf("status %s, want pending", s)
	}
	if s := domain.InvitationStatusAt(now, false, now); s != domain.InvitationExpired {
		t.Errorf("at its expiry: %s, want expired", s)
	}
	if s := domain.InvitationStatusAt(now.Add(-time.Hour), true, now); s != domain.InvitationAccepted {
		t.Errorf("an accepted invitation reports %s after expiry, want accepted", s)
	}
	tok := domain.InvitationTokenPrefix + strings.Repeat("A", 43)
	if !domain.ValidInvitationToken(tok) {
		t.Error("a well-formed token is refused")
	}
	for _, bad := range []string{"", "zpinv_short", strings.Repeat("A", 49), "eyJhbGciOiJSUzI1NiJ9.e30.x", tok + "=", domain.InvitationTokenPrefix + strings.Repeat("!", 43)} {
		if domain.ValidInvitationToken(bad) {
			t.Errorf("token %q accepted", bad)
		}
	}
	h1, h2 := domain.HashInvitationToken(tok), domain.HashInvitationToken(tok+"x")
	if len(h1) != 32 || string(h1) == string(h2) {
		t.Error("token hash is not a distinct 32-byte SHA-256")
	}
}

func TestStepUpGate(t *testing.T) {
	if err := domain.CheckStepUp("TEST"); err != nil {
		t.Errorf("TEST: %v", err)
	}
	for _, env := range []string{"LIVE", "", "live"} {
		if err := domain.CheckStepUp(env); !errors.Is(err, domain.ErrStepUpRequired) {
			t.Errorf("%q: err = %v, want ErrStepUpRequired (Q40: no approvals or revocations outside TEST until step-up exists)", env, err)
		}
	}
}
