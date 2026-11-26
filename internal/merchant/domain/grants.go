package domain

import (
	"crypto/sha256"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Grant administration rules (02-02 WF-002, TENANT.USERS.INVITE,
// TENANT.ROLE.GRANT, TENANT.ROLE.REVOKE; 03-05 §9.2, §13.1; OPEN_QUESTIONS
// Q36 36.10–36.15 and Q40). The database enforces the same rules again
// (db/migrations/merchant/00005_grant_administration.sql), so an application
// bug cannot create an over-broad grant (36.15).

// Persona is a 02-02 merchant persona code.
type Persona string

// Merchant personas. Only MOWN may delegate (36.12), and MOWN itself is not
// delegated here: owner grants come from tenant provisioning (Q40).
const (
	MOWN  Persona = "MOWN"
	MOPS  Persona = "MOPS"
	MFIN  Persona = "MFIN"
	MDEV  Persona = "MDEV"
	MVIEW Persona = "MVIEW"
)

// Delegable lists the personas an owner may grant.
var Delegable = []Persona{MOPS, MFIN, MDEV, MVIEW}

// Person is a verified identity: token issuer and subject. Never an email.
type Person struct {
	Issuer  string
	Subject string
}

// Scope is where a grant applies: a tenant and, unless empty, one merchant.
type Scope struct {
	TenantID   string
	MerchantID string // "" means every merchant of the tenant
}

// OwnerGrant is one of a person's live owner (MOWN) grants.
type OwnerGrant struct {
	TenantID   string
	MerchantID string // "" means tenant-wide
	ExpiresAt  time.Time
}

// Covers reports whether the owner grant covers scope: the same tenant, and a
// tenant-wide owner grant for a tenant-wide scope; a merchant owner grant
// covers only that merchant (36.12).
func (o OwnerGrant) Covers(s Scope) bool {
	return o.TenantID == s.TenantID && (o.MerchantID == "" || o.MerchantID == s.MerchantID)
}

// Delegates reports whether any of owners covers scope and lasts at least
// until until: "never grant above the delegator", and a grant may not
// outlive its source mandate (02-02 role_grant).
func Delegates(owners []OwnerGrant, s Scope, until time.Time) bool {
	return slices.ContainsFunc(owners, func(o OwnerGrant) bool { return o.Covers(s) && !o.ExpiresAt.Before(until) })
}

var (
	// ErrNotDelegable: not one of the four delegable personas (an owner role, or unknown).
	ErrNotDelegable = errors.New("grants: persona cannot be delegated")
	// ErrSoD: maker, checker and member are not three different people (02-02 §6.3 SOD_CONFLICT).
	ErrSoD = errors.New("grants: maker, checker and member must be different people")
	// ErrExceedsDelegator: no live owner grant of the acting person covers and outlasts the scope.
	ErrExceedsDelegator = errors.New("grants: above the delegator's own owner grant")
	// ErrWindow: the validity window is empty, over, or starts in the past.
	ErrWindow = errors.New("grants: invalid validity window")
	// ErrPurpose: purpose or reason missing, too long or carrying a token.
	ErrPurpose = errors.New("grants: purpose or reason must be 1 to 200 characters of text")
	// ErrVersion: If-Match names another version (02-02 §6.3: 409, read the latest).
	ErrVersion = errors.New("grants: stale version")
	// ErrNotPending: already decided, or already revoked.
	ErrNotPending = errors.New("grants: already decided")
	// ErrExpired: the request was not decided in time.
	ErrExpired = errors.New("grants: request expired")
	// ErrStepUpRequired: approvals and revocations need step-up, which is not built (Q40).
	ErrStepUpRequired = errors.New("grants: step-up required")
)

// MaxClockSkew is how far in the past a requested start may lie, for clocks
// that differ slightly between client and server.
const MaxClockSkew = 5 * time.Minute

// MaxTextLen bounds purposes and reasons.
const MaxTextLen = 200

// ValidText reports whether s is an acceptable purpose or reason.
func ValidText(s string) bool {
	t := strings.TrimSpace(s)
	return t != "" && len([]rune(s)) <= MaxTextLen && !strings.Contains(s, "eyJ")
}

// RequestDraft is a maker's request for one role for one member.
type RequestDraft struct {
	Member        Person
	Maker         Person
	Scope         Scope
	Persona       Persona
	EffectiveFrom time.Time
	ExpiresAt     time.Time
	Purpose       string
}

// CheckRequest decides whether maker, holding makerOwners, may ask for d at now.
func CheckRequest(d RequestDraft, makerOwners []OwnerGrant, now time.Time) error {
	switch {
	case !slices.Contains(Delegable, d.Persona):
		return ErrNotDelegable
	case d.Maker == d.Member:
		return ErrSoD
	case !d.ExpiresAt.After(d.EffectiveFrom), !d.ExpiresAt.After(now), d.EffectiveFrom.Before(now.Add(-MaxClockSkew)):
		return ErrWindow
	case !ValidText(d.Purpose):
		return ErrPurpose
	case !Delegates(makerOwners, d.Scope, d.ExpiresAt):
		return ErrExceedsDelegator
	}
	return nil
}

// RequestStatus is an access request's state (03-05 §9.2 names).
type RequestStatus string

// Request states. Expired is derived, never stored: a request still awaiting
// approval at its decision date can no longer be decided.
const (
	Awaiting RequestStatus = "AWAITING_INDEPENDENT_APPROVAL"
	Approved RequestStatus = "APPROVED"
	Rejected RequestStatus = "REJECTED"
	Expired  RequestStatus = "EXPIRED"
)

// RequestState is a stored access request, as the rules need it.
type RequestState struct {
	Status        RequestStatus
	Maker         Person
	Member        Person
	Scope         Scope
	Persona       Persona
	EffectiveFrom time.Time
	ExpiresAt     time.Time
	DecisionDue   time.Time
	Version       int64
}

// StatusAt is the request's status at now, with Expired derived.
func (r RequestState) StatusAt(now time.Time) RequestStatus {
	if r.Status == Awaiting && !now.Before(r.DecisionDue) {
		return Expired
	}
	return r.Status
}

func (r RequestState) decidable(version int64, now time.Time) error {
	switch {
	case version != r.Version:
		return ErrVersion
	case r.Status != Awaiting:
		return ErrNotPending
	case r.StatusAt(now) == Expired:
		return ErrExpired
	}
	return nil
}

// CheckApproval decides whether checker may approve r at now. Both the
// checker's and the maker's owner grants must still cover and outlast it.
func CheckApproval(r RequestState, checker Person, checkerOwners, makerOwners []OwnerGrant, version int64, now time.Time) error {
	if err := r.decidable(version, now); err != nil {
		return err
	}
	switch {
	case checker == r.Maker, checker == r.Member:
		return ErrSoD
	case !r.ExpiresAt.After(now):
		return ErrWindow
	case !Delegates(checkerOwners, r.Scope, r.ExpiresAt), !Delegates(makerOwners, r.Scope, r.ExpiresAt):
		return ErrExceedsDelegator
	}
	return nil
}

// CheckRejection decides whether by may reject r. Any owner covering it may,
// the maker included (a withdrawal), but never the member.
func CheckRejection(r RequestState, by Person, byOwners []OwnerGrant, version int64, reason string, now time.Time) error {
	if err := r.decidable(version, now); err != nil {
		return err
	}
	switch {
	case by == r.Member:
		return ErrSoD
	case !ValidText(reason):
		return ErrPurpose
	case !slices.ContainsFunc(byOwners, func(o OwnerGrant) bool { return o.Covers(r.Scope) }):
		return ErrExceedsDelegator
	}
	return nil
}

// GrantWindow is the grant an approval at now creates: from the later of the
// requested start and now, until the requested end.
func (r RequestState) GrantWindow(now time.Time) (effectiveFrom, expiresAt time.Time) {
	from := r.EffectiveFrom
	if from.Before(now) {
		from = now
	}
	return from, r.ExpiresAt
}

// GrantState is a stored grant, as revocation needs it.
type GrantState struct {
	Persona Persona
	Scope   Scope
	Revoked bool
}

// CheckRevocation decides whether a person holding revokerOwners may revoke g.
func CheckRevocation(g GrantState, revokerOwners []OwnerGrant) error {
	switch {
	case !slices.Contains(Delegable, g.Persona):
		return ErrNotDelegable
	case g.Revoked:
		return ErrNotPending
	case !slices.ContainsFunc(revokerOwners, func(o OwnerGrant) bool { return o.Covers(g.Scope) }):
		return ErrExceedsDelegator
	}
	return nil
}

// InvitationStatus is an invitation's state.
type InvitationStatus string

// Invitation states.
const (
	InvitationPending  InvitationStatus = "pending"
	InvitationAccepted InvitationStatus = "accepted"
	InvitationExpired  InvitationStatus = "expired"
)

// InvitationStatusAt is an invitation's state at now.
func InvitationStatusAt(expiresAt time.Time, accepted bool, now time.Time) InvitationStatus {
	switch {
	case accepted:
		return InvitationAccepted
	case !now.Before(expiresAt):
		return InvitationExpired
	}
	return InvitationPending
}

// InvitationTokenPrefix marks invitation tokens, so a leaked one is
// recognizable and cannot be confused with an access token.
const InvitationTokenPrefix = "zpinv_"

var tokenFormat = regexp.MustCompile(`^zpinv_[A-Za-z0-9_-]{43}$`) // 32 random bytes, base64url without padding

// ValidInvitationToken reports whether s has the shape of an invitation token.
func ValidInvitationToken(s string) bool { return tokenFormat.MatchString(s) }

// HashInvitationToken is the SHA-256 stored in place of the token.
func HashInvitationToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// CheckStepUp refuses approvals and revocations outside TEST: 02-02 §2.4
// requires fresh step-up for role approvals, and step-up is not built yet
// (Q40). A TEST deployment holds no real authority.
func CheckStepUp(environment string) error {
	if environment != "TEST" {
		return ErrStepUpRequired
	}
	return nil
}
