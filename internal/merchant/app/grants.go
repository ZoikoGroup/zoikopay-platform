package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zoiko/zoikopay/internal/merchant/domain"
	"github.com/zoiko/zoikopay/internal/merchant/store"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/idempotency"
	"github.com/zoiko/zoikopay/internal/platform/ids"
)

// Grant administration (02-02 WF-002; OPEN_QUESTIONS Q40). Owners (MOWN) of a
// tenant invite people, request roles for them (maker) and approve or reject
// requests (checker); maker, checker and member are three different people;
// no one grants above their own owner grant. Every rule is checked here with
// internal/merchant/domain and again by the database itself.

var (
	// ErrSoD: maker, checker and member are not three different people.
	ErrSoD = errors.New("maker, checker and member must differ")
	// ErrDelegation: beyond the acting owner's own owner grant.
	ErrDelegation = errors.New("beyond the delegator's own owner grant")
	// ErrStepUp: approvals and revocations need step-up outside TEST.
	ErrStepUp = errors.New("step-up required")
	// ErrVersion: If-Match names another version.
	ErrVersion = errors.New("stale version")
	// ErrState: already decided, expired, revoked, or the role is already held.
	ErrState = errors.New("not allowed in the current state")
	// ErrInProgress: the same Idempotency-Key is still being processed.
	ErrInProgress = errors.New("operation in progress")
	// ErrKeyReuse: the same Idempotency-Key was used with a different request.
	ErrKeyReuse = errors.New("idempotency key reused with a different request")
)

// InvalidError is a request field that is not valid (422).
type InvalidError struct {
	Field  string
	Reason string
}

func (e *InvalidError) Error() string { return e.Field + ": " + e.Reason }

func invalid(field, reason string) error { return &InvalidError{Field: field, Reason: reason} }

// GrantAdmin is BC-01's grant administration service.
type GrantAdmin struct {
	pool          db.Beginner // zp_gateway
	environment   string      // the deployment's, TEST or LIVE
	invitationTTL time.Duration
	requestTTL    time.Duration
	now           func() time.Time
	random        io.Reader
}

// NewGrantAdmin returns the service. Both lifetimes are required settings with
// no default (Q36 36.10, Q40).
func NewGrantAdmin(pool db.Beginner, environment string, invitationTTL, requestTTL time.Duration) (*GrantAdmin, error) {
	switch {
	case pool == nil:
		return nil, errors.New("grant administration: a database pool is required")
	case environment != "TEST" && environment != "LIVE":
		return nil, fmt.Errorf("grant administration: environment %q is not TEST or LIVE", environment)
	case invitationTTL <= 0:
		return nil, errors.New("grant administration: the invitation lifetime must be configured (no default)")
	case requestTTL <= 0:
		return nil, errors.New("grant administration: the access request lifetime must be configured (no default)")
	}
	return &GrantAdmin{pool: pool, environment: environment, invitationTTL: invitationTTL, requestTTL: requestTTL,
		now: time.Now, random: rand.Reader}, nil
}

// --- records returned to the HTTP layer -------------------------------------

// Invitation is an invitation as its tenant's owners see it.
type Invitation struct {
	ID, TenantID string
	Status       domain.InvitationStatus
	InvitedBy    domain.Person
	AcceptedBy   *domain.Person
	CreatedAt    time.Time
	ExpiresAt    time.Time
	AcceptedAt   *time.Time
	Token        string // only on the first creation response
}

// AccessRequest is an access request with its derived status.
type AccessRequest struct {
	ID, TenantID   string
	Member, Maker  domain.Person
	MerchantID     string
	Persona        domain.Persona
	EffectiveFrom  time.Time
	ExpiresAt      time.Time
	Purpose        string
	Status         domain.RequestStatus
	RequestedAt    time.Time
	DecisionDue    time.Time
	DecidedBy      *domain.Person
	DecidedAt      *time.Time
	DecisionReason string
	MembershipID   string
	Version        int64
}

// Membership is a grant as its tenant's owners see it.
type Membership struct {
	ID, TenantID          string
	Member                domain.Person
	MerchantID            string
	Persona               domain.Persona
	EffectiveFrom         time.Time
	ExpiresAt             time.Time
	GrantedBy, ApprovedBy domain.Person
	GrantedAt             time.Time
	RevokedBy             *domain.Person
	RevokedAt             *time.Time
	AccessRequestID       string
}

// RequestInput is a maker's request. Exactly one of InvitationID and
// MembershipID names the member.
type RequestInput struct {
	InvitationID, MembershipID string
	MerchantID                 string
	Persona                    domain.Persona
	EffectiveFrom, ExpiresAt   time.Time
	Purpose                    string
}

// --- the caller's standing in a tenant ----------------------------------------

func person(p authz.Principal) domain.Person {
	return domain.Person{Issuer: p.Identity.Issuer, Subject: p.Identity.Subject}
}

// enter returns the caller's live owner grants in tenant. A tenant the caller
// holds no grant in is ErrNotFound, like one that does not exist (Q37 37.5); a
// member who is not an owner is ErrForbidden (TENANT.USERS.INVITE,
// TENANT.ROLE.GRANT, TENANT.ROLE.REVOKE: MOWN; PIAM and PSEC are staff, Q36 36.13).
func (s *GrantAdmin) enter(p authz.Principal, tenant string) ([]domain.OwnerGrant, error) {
	if _, err := ids.Parse(ids.Tenant, tenant); err != nil || !slices.Contains(p.Tenants(), tenant) || p.Environment != s.environment {
		return nil, ErrNotFound
	}
	var owners []domain.OwnerGrant
	for _, g := range p.Grants() {
		if g.TenantID == tenant && g.Persona == authz.MOWN {
			owners = append(owners, domain.OwnerGrant{TenantID: g.TenantID, MerchantID: g.MerchantID, ExpiresAt: g.ExpiresAt})
		}
	}
	if len(owners) == 0 {
		return nil, ErrForbidden
	}
	return owners, nil
}

// ownersOf reads a person's live owner grants in tenant inside tx, so a grant
// revoked since the caller's principal was resolved no longer counts.
func (s *GrantAdmin) ownersOf(ctx context.Context, tx pgx.Tx, tenant string, who domain.Person) ([]domain.OwnerGrant, error) {
	rows, err := store.New(tx).LiveOwnerGrants(ctx, store.LiveOwnerGrantsParams{
		TenantID: tenant, Environment: s.environment, Issuer: who.Issuer, Subject: who.Subject, Now: s.now().UTC(),
	})
	if err != nil {
		return nil, err
	}
	out := make([]domain.OwnerGrant, 0, len(rows))
	for _, r := range rows {
		out = append(out, domain.OwnerGrant{TenantID: tenant, MerchantID: deref(r.MerchantID), ExpiresAt: r.ExpiresAtUtc.UTC()})
	}
	return out, nil
}

func covers(owners []domain.OwnerGrant, sc domain.Scope) bool {
	return slices.ContainsFunc(owners, func(o domain.OwnerGrant) bool { return o.Covers(sc) })
}

// --- idempotency --------------------------------------------------------------

type keyed struct {
	key   idempotency.Key
	route string
	kind  string
	body  map[string]any
	path  map[string]string
}

// reserve claims k for the caller in tenant. A replay returns the resource ID
// the first request recorded.
func (s *GrantAdmin) reserve(ctx context.Context, tx pgx.Tx, p authz.Principal, tenant string, k keyed) (idempotency.Result, error) {
	fp, err := idempotency.Fingerprint(idempotency.Input{OperationKind: k.kind, Method: http.MethodPost, Route: k.route,
		PathParams: k.path, Body: k.body})
	if err != nil {
		return idempotency.Result{}, err
	}
	scope := idempotency.Scope{Environment: s.environment, CellID: authz.NoScope, LegalEntityID: authz.NoScope,
		TenantID: tenant, MerchantID: authz.NoScope, ClientID: p.Identity.Issuer,
		PrincipalID: p.Identity.Issuer + " " + p.Identity.Subject, APIMajor: 1, Method: http.MethodPost,
		RouteTemplate: k.route, OperationKind: k.kind}
	r, err := idempotency.Registry{Schema: "merchant", Now: s.now}.Reserve(ctx, tx, scope, k.key, fp, ids.NewInternal())
	if err != nil {
		return r, err
	}
	switch r.Outcome {
	case idempotency.InProgress:
		return r, ErrInProgress
	case idempotency.Mismatch:
		return r, ErrKeyReuse
	}
	return r, nil
}

func (s *GrantAdmin) complete(ctx context.Context, tx pgx.Tx, r idempotency.Result, status int, resource string) error {
	return idempotency.Registry{Schema: "merchant", Now: s.now}.Complete(ctx, tx, r.OperationID, status, resource)
}

// --- invitations --------------------------------------------------------------

// CreateInvitation issues a single-use invitation to tenant. The returned
// Invitation carries the one-time token only when created is true; a replay
// returns the invitation without it.
func (s *GrantAdmin) CreateInvitation(ctx context.Context, p authz.Principal, tenant string, key idempotency.Key) (inv Invitation, created bool, err error) {
	if _, err := s.enter(p, tenant); err != nil {
		return Invitation{}, false, err
	}
	token, err := s.newToken()
	if err != nil {
		return Invitation{}, false, err
	}
	now := s.now().UTC()
	err = authz.InTenantTx(ctx, s.pool, p, tenant, func(tx pgx.Tx) error {
		q := store.New(tx)
		r, err := s.reserve(ctx, tx, p, tenant, keyed{key: key, route: "/v1/tenants/{tenant_id}/invitations", kind: "invitation.create",
			path: map[string]string{"tenant_id": tenant}, body: map[string]any{}})
		if err != nil {
			return err
		}
		if r.Outcome == idempotency.Replay {
			row, err := q.GetInvitation(ctx, store.GetInvitationParams{InvitationID: r.ResourceID, TenantID: tenant, Environment: s.environment})
			inv = invitation(row, now)
			return err
		}
		row, err := q.InsertInvitation(ctx, store.InsertInvitationParams{InvitationID: ids.NewPublic(ids.Invitation), TenantID: tenant,
			Environment: s.environment, TokenHash: domain.HashInvitationToken(token), InvitedByIssuer: p.Identity.Issuer,
			InvitedBySubject: p.Identity.Subject, ExpiresAtUtc: now.Add(s.invitationTTL)})
		if err != nil {
			return dbError(err)
		}
		inv, inv.Token, created = invitation(row, now), token, true
		return s.complete(ctx, tx, r, http.StatusCreated, row.InvitationID)
	})
	if err != nil {
		return Invitation{}, false, err
	}
	return inv, created, nil
}

// ListInvitations returns tenant's invitations, newest first, without tokens.
func (s *GrantAdmin) ListInvitations(ctx context.Context, p authz.Principal, tenant string) ([]Invitation, error) {
	if _, err := s.enter(p, tenant); err != nil {
		return nil, err
	}
	var out []Invitation
	now := s.now().UTC()
	err := authz.InTenantTx(ctx, s.pool, p, tenant, func(tx pgx.Tx) error {
		rows, err := store.New(tx).ListInvitations(ctx, store.ListInvitationsParams{TenantID: tenant, Environment: s.environment})
		for _, r := range rows {
			out = append(out, invitation(r, now))
		}
		return err
	})
	return out, err
}

// AcceptInvitation binds the caller to the invitation token names. An
// unknown, malformed, expired or used token is ErrNotFound, all alike
// (02-02 AT-014). It returns the invitation's tenant for the audit entry only
// once the caller has accepted it.
func (s *GrantAdmin) AcceptInvitation(ctx context.Context, p authz.Principal, token string, key idempotency.Key) (Invitation, error) {
	if !domain.ValidInvitationToken(token) {
		return Invitation{}, ErrNotFound
	}
	hash := domain.HashInvitationToken(token)
	me := person(p)
	now := s.now().UTC()
	var inv Invitation
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('zp.invitation_token_hash', $1, true)`, hex.EncodeToString(hash)); err != nil {
			return err
		}
		q := store.New(tx)
		row, err := q.InvitationByToken(ctx, hash)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if row.Environment != s.environment {
			return ErrNotFound
		}
		// The idempotency key lives in the invitation's tenant.
		if err := db.SetTenant(ctx, tx, db.Tenant{Environment: s.environment, CellID: authz.NoScope, LegalEntityID: authz.NoScope, TenantID: row.TenantID}); err != nil {
			return err
		}
		r, err := s.reserve(ctx, tx, p, row.TenantID, keyed{key: key, route: "/v1/invitations/accept", kind: "invitation.accept",
			body: map[string]any{"token_sha256": hex.EncodeToString(hash)}})
		if err != nil {
			return err
		}
		if r.Outcome == idempotency.Replay {
			if row.AcceptedBySubject == nil || (domain.Person{Issuer: deref(row.AcceptedByIssuer), Subject: *row.AcceptedBySubject}) != me {
				return ErrNotFound
			}
			inv = invitation(row, now)
			return nil
		}
		switch {
		case row.AcceptedAtUtc != nil, !now.Before(row.ExpiresAtUtc):
			return ErrNotFound
		case (domain.Person{Issuer: row.InvitedByIssuer, Subject: row.InvitedBySubject}) == me:
			return ErrSoD
		}
		accepted, err := q.AcceptInvitation(ctx, store.AcceptInvitationParams{TokenHash: hash, AcceptedByIssuer: &me.Issuer, AcceptedBySubject: &me.Subject})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return dbError(err)
		}
		inv = invitation(accepted, now)
		return s.complete(ctx, tx, r, http.StatusOK, accepted.InvitationID)
	})
	return inv, err
}

func (s *GrantAdmin) newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(s.random, b); err != nil {
		return "", fmt.Errorf("invitation token: %w", err)
	}
	return domain.InvitationTokenPrefix + base64.RawURLEncoding.EncodeToString(b), nil
}

// --- access requests ------------------------------------------------------------

// CreateAccessRequest records a maker's request for one role.
func (s *GrantAdmin) CreateAccessRequest(ctx context.Context, p authz.Principal, tenant string, in RequestInput, key idempotency.Key) (AccessRequest, bool, error) {
	if _, err := s.enter(p, tenant); err != nil {
		return AccessRequest{}, false, err
	}
	if (in.InvitationID == "") == (in.MembershipID == "") {
		return AccessRequest{}, false, invalid("invitation_id", "give exactly one of invitation_id and membership_id")
	}
	if in.MerchantID != "" {
		if _, err := ids.Parse(ids.Merchant, in.MerchantID); err != nil {
			return AccessRequest{}, false, invalid("merchant_id", "not a merchant ID")
		}
	}
	now := s.now().UTC()
	var (
		out     AccessRequest
		created bool
	)
	err := authz.InTenantTx(ctx, s.pool, p, tenant, func(tx pgx.Tx) error {
		q := store.New(tx)
		r, err := s.reserve(ctx, tx, p, tenant, keyed{key: key, route: "/v1/tenants/{tenant_id}/access_requests", kind: "access_request.create",
			path: map[string]string{"tenant_id": tenant}, body: map[string]any{
				"invitation_id": in.InvitationID, "membership_id": in.MembershipID, "merchant_id": in.MerchantID,
				"persona": string(in.Persona), "effective_from": in.EffectiveFrom.UTC().Format(time.RFC3339Nano),
				"expires_at": in.ExpiresAt.UTC().Format(time.RFC3339Nano), "purpose": in.Purpose,
			}})
		if err != nil {
			return err
		}
		if r.Outcome == idempotency.Replay {
			out, err = s.getRequest(ctx, q, tenant, r.ResourceID, now)
			return err
		}
		member, err := s.resolveMember(ctx, q, tenant, in, now)
		if err != nil {
			return err
		}
		makerOwners, err := s.ownersOf(ctx, tx, tenant, person(p))
		if err != nil {
			return err
		}
		draft := domain.RequestDraft{Member: member, Maker: person(p), Scope: domain.Scope{TenantID: tenant, MerchantID: in.MerchantID},
			Persona: in.Persona, EffectiveFrom: in.EffectiveFrom.UTC(), ExpiresAt: in.ExpiresAt.UTC(), Purpose: in.Purpose}
		if err := ruleError(domain.CheckRequest(draft, makerOwners, now)); err != nil {
			return err
		}
		if in.MerchantID != "" {
			if _, err := q.GetMerchant(ctx, store.GetMerchantParams{MerchantID: in.MerchantID, Environment: s.environment}); errors.Is(err, pgx.ErrNoRows) {
				return invalid("merchant_id", "not a merchant of this tenant")
			} else if err != nil {
				return err
			}
		}
		row, err := q.InsertAccessRequest(ctx, store.InsertAccessRequestParams{AccessRequestID: ids.NewPublic(ids.AccessRequest),
			TenantID: tenant, Environment: s.environment, MemberIssuer: member.Issuer, MemberSubject: member.Subject,
			MerchantID: opt(in.MerchantID), Persona: string(in.Persona), EffectiveFromUtc: draft.EffectiveFrom, ExpiresAtUtc: draft.ExpiresAt,
			Purpose: in.Purpose, RequestedByIssuer: p.Identity.Issuer, RequestedBySubject: p.Identity.Subject,
			DecisionDueAtUtc: now.Add(s.requestTTL)})
		if err != nil {
			return dbError(err)
		}
		out, created = accessRequest(row, nil, now), true
		return s.complete(ctx, tx, r, http.StatusCreated, row.AccessRequestID)
	})
	return out, created, err
}

// resolveMember finds the person a request is for: whoever accepted the named
// invitation to this tenant, or the holder of the named live grant here.
func (s *GrantAdmin) resolveMember(ctx context.Context, q *store.Queries, tenant string, in RequestInput, now time.Time) (domain.Person, error) {
	if in.InvitationID != "" {
		inv, err := q.GetInvitation(ctx, store.GetInvitationParams{InvitationID: in.InvitationID, TenantID: tenant, Environment: s.environment})
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && inv.AcceptedBySubject == nil) {
			return domain.Person{}, invalid("invitation_id", "not an accepted invitation to this tenant")
		}
		if err != nil {
			return domain.Person{}, err
		}
		return domain.Person{Issuer: deref(inv.AcceptedByIssuer), Subject: *inv.AcceptedBySubject}, nil
	}
	m, err := q.GetMembership(ctx, store.GetMembershipParams{MembershipID: in.MembershipID, TenantID: tenant, Environment: s.environment})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (m.RevokedAtUtc != nil || !m.ExpiresAtUtc.After(now))) {
		return domain.Person{}, invalid("membership_id", "not a live grant in this tenant")
	}
	if err != nil {
		return domain.Person{}, err
	}
	return domain.Person{Issuer: m.Issuer, Subject: m.Subject}, nil
}

// ListAccessRequests returns the requests the caller's owner grants cover,
// newest first, optionally only those in status (derived Expired included).
func (s *GrantAdmin) ListAccessRequests(ctx context.Context, p authz.Principal, tenant string, status domain.RequestStatus) ([]AccessRequest, error) {
	owners, err := s.enter(p, tenant)
	if err != nil {
		return nil, err
	}
	now := s.now().UTC()
	var out []AccessRequest
	err = authz.InTenantTx(ctx, s.pool, p, tenant, func(tx pgx.Tx) error {
		rows, err := store.New(tx).ListAccessRequests(ctx, store.ListAccessRequestsParams{TenantID: tenant, Environment: s.environment})
		for _, r := range rows {
			ar := accessRequest(requestRow(store.GetAccessRequestRow(r)), r.GrantedMembershipID, now)
			if covers(owners, domain.Scope{TenantID: tenant, MerchantID: ar.MerchantID}) && (status == "" || ar.Status == status) {
				out = append(out, ar)
			}
		}
		return err
	})
	return out, err
}

func (s *GrantAdmin) getRequest(ctx context.Context, q *store.Queries, tenant, id string, now time.Time) (AccessRequest, error) {
	r, err := q.GetAccessRequest(ctx, store.GetAccessRequestParams{AccessRequestID: id, TenantID: tenant, Environment: s.environment})
	if errors.Is(err, pgx.ErrNoRows) {
		return AccessRequest{}, ErrNotFound
	}
	if err != nil {
		return AccessRequest{}, err
	}
	return accessRequest(requestRow(r), r.GrantedMembershipID, now), nil
}

// Decision is an approval or a rejection of one request version.
type Decision struct {
	Approve bool
	Version int64
	Reason  string // required for a rejection
}

// Decide approves or rejects a request. An approval creates the grant in the
// same transaction. Approvals are refused outside TEST until step-up exists.
func (s *GrantAdmin) Decide(ctx context.Context, p authz.Principal, tenant, requestID string, d Decision, key idempotency.Key) (AccessRequest, error) {
	if _, err := s.enter(p, tenant); err != nil {
		return AccessRequest{}, err
	}
	if _, err := ids.Parse(ids.AccessRequest, requestID); err != nil {
		return AccessRequest{}, ErrNotFound
	}
	if d.Approve {
		if err := ruleError(domain.CheckStepUp(s.environment)); err != nil {
			return AccessRequest{}, err
		}
	}
	route, kind, body := "/v1/tenants/{tenant_id}/access_requests/{access_request_id}/rejection", "access_request.reject",
		map[string]any{"version": d.Version, "reason": d.Reason}
	if d.Approve {
		route, kind, body = "/v1/tenants/{tenant_id}/access_requests/{access_request_id}/approval", "access_request.approve", map[string]any{"version": d.Version}
	}
	now := s.now().UTC()
	me := person(p)
	var out AccessRequest
	err := authz.InTenantTx(ctx, s.pool, p, tenant, func(tx pgx.Tx) error {
		q := store.New(tx)
		r, err := s.reserve(ctx, tx, p, tenant, keyed{key: key, route: route, kind: kind,
			path: map[string]string{"tenant_id": tenant, "access_request_id": requestID}, body: body})
		if err != nil {
			return err
		}
		if r.Outcome == idempotency.Replay {
			out, err = s.getRequest(ctx, q, tenant, r.ResourceID, now)
			return err
		}
		row, err := q.LockAccessRequest(ctx, store.LockAccessRequestParams{AccessRequestID: requestID, TenantID: tenant, Environment: s.environment})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		state := requestState(row)
		myOwners, err := s.ownersOf(ctx, tx, tenant, me)
		if err != nil {
			return err
		}
		if d.Approve {
			makerOwners, err := s.ownersOf(ctx, tx, tenant, state.Maker)
			if err != nil {
				return err
			}
			if err := ruleError(domain.CheckApproval(state, me, myOwners, makerOwners, d.Version, now)); err != nil {
				return err
			}
		} else if err := ruleError(domain.CheckRejection(state, me, myOwners, d.Version, d.Reason, now)); err != nil {
			return err
		}
		status, reason := string(domain.Approved), (*string)(nil)
		if !d.Approve {
			status, reason = string(domain.Rejected), &d.Reason
		}
		decided, err := q.DecideAccessRequest(ctx, store.DecideAccessRequestParams{ID: row.ID, Status: status,
			DecidedByIssuer: &me.Issuer, DecidedBySubject: &me.Subject, DecisionReason: reason, Version: d.Version})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrVersion
		}
		if err != nil {
			return dbError(err)
		}
		var granted *string
		if d.Approve {
			id, err := q.InsertGrantFromRequest(ctx, row.ID)
			if err != nil {
				return dbError(err)
			}
			granted = &id
		}
		out = accessRequest(decided, granted, now)
		return s.complete(ctx, tx, r, http.StatusOK, decided.AccessRequestID)
	})
	return out, err
}

// --- memberships ---------------------------------------------------------------

// ListMemberships returns the tenant's live grants that the caller's owner grants cover.
func (s *GrantAdmin) ListMemberships(ctx context.Context, p authz.Principal, tenant string) ([]Membership, error) {
	owners, err := s.enter(p, tenant)
	if err != nil {
		return nil, err
	}
	var out []Membership
	err = authz.InTenantTx(ctx, s.pool, p, tenant, func(tx pgx.Tx) error {
		rows, err := store.New(tx).ListLiveMemberships(ctx, store.ListLiveMembershipsParams{TenantID: tenant, Environment: s.environment, Now: s.now().UTC()})
		for _, r := range rows {
			if covers(owners, domain.Scope{TenantID: tenant, MerchantID: deref(r.MerchantID)}) {
				out = append(out, membership(store.GetMembershipRow(r)))
			}
		}
		return err
	})
	return out, err
}

// Revoke revokes a delegable grant at once. Refused outside TEST until step-up exists.
func (s *GrantAdmin) Revoke(ctx context.Context, p authz.Principal, tenant, membershipID, reason string, key idempotency.Key) (Membership, error) {
	if _, err := s.enter(p, tenant); err != nil {
		return Membership{}, err
	}
	if _, err := ids.Parse(ids.Membership, membershipID); err != nil {
		return Membership{}, ErrNotFound
	}
	if err := ruleError(domain.CheckStepUp(s.environment)); err != nil {
		return Membership{}, err
	}
	if !domain.ValidText(reason) {
		return Membership{}, invalid("reason", "1 to 200 characters")
	}
	me := person(p)
	var out Membership
	err := authz.InTenantTx(ctx, s.pool, p, tenant, func(tx pgx.Tx) error {
		q := store.New(tx)
		r, err := s.reserve(ctx, tx, p, tenant, keyed{key: key, route: "/v1/tenants/{tenant_id}/memberships/{membership_id}/revocation",
			kind: "membership.revoke", path: map[string]string{"tenant_id": tenant, "membership_id": membershipID},
			body: map[string]any{"reason": reason}})
		if err != nil {
			return err
		}
		if r.Outcome != idempotency.Replay {
			m, err := q.LockMembership(ctx, store.LockMembershipParams{MembershipID: membershipID, TenantID: tenant, Environment: s.environment})
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
			myOwners, err := s.ownersOf(ctx, tx, tenant, me)
			if err != nil {
				return err
			}
			target := domain.GrantState{Persona: domain.Persona(m.Persona), Scope: domain.Scope{TenantID: tenant, MerchantID: deref(m.MerchantID)},
				Revoked: m.RevokedAtUtc != nil}
			if err := domain.CheckRevocation(target, myOwners); err != nil {
				if errors.Is(err, domain.ErrNotDelegable) || errors.Is(err, domain.ErrExceedsDelegator) {
					return ErrForbidden // owner grants come from provisioning; others need a covering owner
				}
				return ruleError(err)
			}
			if _, err := q.RevokeMembership(ctx, store.RevokeMembershipParams{ID: m.ID, RevokedByIssuer: &me.Issuer,
				RevokedBySubject: &me.Subject, RevocationReason: &reason}); err != nil {
				return dbError(err)
			}
			if err := s.complete(ctx, tx, r, http.StatusOK, membershipID); err != nil {
				return err
			}
		}
		row, err := q.GetMembership(ctx, store.GetMembershipParams{MembershipID: membershipID, TenantID: tenant, Environment: s.environment})
		if err != nil {
			return err
		}
		out = membership(row)
		return nil
	})
	return out, err
}

// --- mapping ---------------------------------------------------------------------

// ruleError maps a domain rule to the service's errors.
func ruleError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, domain.ErrSoD):
		return ErrSoD
	case errors.Is(err, domain.ErrExceedsDelegator):
		return ErrDelegation
	case errors.Is(err, domain.ErrNotDelegable):
		return ErrForbidden
	case errors.Is(err, domain.ErrStepUpRequired):
		return ErrStepUp
	case errors.Is(err, domain.ErrVersion):
		return ErrVersion
	case errors.Is(err, domain.ErrNotPending), errors.Is(err, domain.ErrExpired):
		return ErrState
	case errors.Is(err, domain.ErrWindow):
		return invalid("expires_at", "the validity window is empty, over, or starts in the past")
	case errors.Is(err, domain.ErrPurpose):
		return invalid("reason", "1 to 200 characters of text")
	}
	return err
}

// dbError maps a database refusal. The application checks the same rules
// first, so these mean a race (a grant revoked meanwhile) or a duplicate.
func dbError(err error) error {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		return err
	}
	switch pg.Code {
	case "23505": // the member already holds this role (one active grant per scope and persona)
		return ErrState
	case "42501": // the database's own delegation rules (00005_grant_administration.sql)
		return ErrDelegation
	case "23001": // decided, used or expired meanwhile
		return ErrState
	case "23514":
		return invalid("request", "refused by a database check")
	}
	return err
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func opt(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func invitation(r store.MerchantInvitation, now time.Time) Invitation {
	inv := Invitation{ID: r.InvitationID, TenantID: r.TenantID,
		Status:    domain.InvitationStatusAt(r.ExpiresAtUtc, r.AcceptedAtUtc != nil, now),
		InvitedBy: domain.Person{Issuer: r.InvitedByIssuer, Subject: r.InvitedBySubject},
		CreatedAt: r.CreatedAtUtc.UTC(), ExpiresAt: r.ExpiresAtUtc.UTC()}
	if r.AcceptedAtUtc != nil && r.AcceptedBySubject != nil {
		at := r.AcceptedAtUtc.UTC()
		inv.AcceptedBy, inv.AcceptedAt = &domain.Person{Issuer: deref(r.AcceptedByIssuer), Subject: *r.AcceptedBySubject}, &at
	}
	return inv
}

// requestRow drops the joined grant ID from a request row.
func requestRow(r store.GetAccessRequestRow) store.MerchantAccessRequest {
	return store.MerchantAccessRequest{ID: r.ID, AccessRequestID: r.AccessRequestID, TenantID: r.TenantID, Environment: r.Environment,
		MemberIssuer: r.MemberIssuer, MemberSubject: r.MemberSubject, MerchantID: r.MerchantID, Persona: r.Persona,
		EffectiveFromUtc: r.EffectiveFromUtc, ExpiresAtUtc: r.ExpiresAtUtc, Purpose: r.Purpose, RequestedByIssuer: r.RequestedByIssuer,
		RequestedBySubject: r.RequestedBySubject, RequestedAtUtc: r.RequestedAtUtc, DecisionDueAtUtc: r.DecisionDueAtUtc, Status: r.Status,
		DecidedByIssuer: r.DecidedByIssuer, DecidedBySubject: r.DecidedBySubject, DecidedAtUtc: r.DecidedAtUtc,
		DecisionReason: r.DecisionReason, Version: r.Version}
}

func requestState(r store.MerchantAccessRequest) domain.RequestState {
	return domain.RequestState{Status: domain.RequestStatus(r.Status),
		Maker:  domain.Person{Issuer: r.RequestedByIssuer, Subject: r.RequestedBySubject},
		Member: domain.Person{Issuer: r.MemberIssuer, Subject: r.MemberSubject},
		Scope:  domain.Scope{TenantID: r.TenantID, MerchantID: deref(r.MerchantID)}, Persona: domain.Persona(r.Persona),
		EffectiveFrom: r.EffectiveFromUtc.UTC(), ExpiresAt: r.ExpiresAtUtc.UTC(), DecisionDue: r.DecisionDueAtUtc.UTC(), Version: r.Version}
}

func accessRequest(r store.MerchantAccessRequest, membershipID *string, now time.Time) AccessRequest {
	st := requestState(r)
	ar := AccessRequest{ID: r.AccessRequestID, TenantID: r.TenantID, Member: st.Member, Maker: st.Maker, MerchantID: st.Scope.MerchantID,
		Persona: st.Persona, EffectiveFrom: st.EffectiveFrom, ExpiresAt: st.ExpiresAt, Purpose: r.Purpose, Status: st.StatusAt(now),
		RequestedAt: r.RequestedAtUtc.UTC(), DecisionDue: st.DecisionDue, DecisionReason: deref(r.DecisionReason),
		MembershipID: deref(membershipID), Version: r.Version}
	if r.DecidedBySubject != nil && r.DecidedAtUtc != nil {
		at := r.DecidedAtUtc.UTC()
		ar.DecidedBy, ar.DecidedAt = &domain.Person{Issuer: deref(r.DecidedByIssuer), Subject: *r.DecidedBySubject}, &at
	}
	return ar
}

func membership(r store.GetMembershipRow) Membership {
	m := Membership{ID: r.MembershipID, TenantID: r.TenantID, Member: domain.Person{Issuer: r.Issuer, Subject: r.Subject},
		MerchantID: deref(r.MerchantID), Persona: domain.Persona(r.Persona), EffectiveFrom: r.EffectiveFromUtc.UTC(),
		ExpiresAt: r.ExpiresAtUtc.UTC(), GrantedBy: domain.Person{Issuer: r.GrantedByIssuer, Subject: r.GrantedBySubject},
		ApprovedBy: domain.Person{Issuer: r.ApprovedByIssuer, Subject: r.ApprovedBySubject}, GrantedAt: r.GrantedAtUtc.UTC(),
		AccessRequestID: deref(r.RequestPublicID)}
	if r.RevokedAtUtc != nil && r.RevokedBySubject != nil {
		at := r.RevokedAtUtc.UTC()
		m.RevokedBy, m.RevokedAt = &domain.Person{Issuer: deref(r.RevokedByIssuer), Subject: *r.RevokedBySubject}, &at
	}
	return m
}
