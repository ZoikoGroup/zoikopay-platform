package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	stdhttp "net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/zoiko/zoikopay/internal/apigen/publicapi"
	"github.com/zoiko/zoikopay/internal/merchant/app"
	"github.com/zoiko/zoikopay/internal/merchant/domain"
	"github.com/zoiko/zoikopay/internal/platform/apierror"
	"github.com/zoiko/zoikopay/internal/platform/audit"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/httpauth"
	"github.com/zoiko/zoikopay/internal/platform/idempotency"
	"github.com/zoiko/zoikopay/internal/platform/trace"
)

// Grant administration endpoints (api/openapi/public.v1.yaml tag "grants";
// OPEN_QUESTIONS Q40). Rules live in internal/merchant/domain and again in
// the database; this layer decodes, maps errors to problems and audits.

const maxBody = 16 << 10

// principal returns the caller; only unreachable without Mount's middleware.
func principal(w stdhttp.ResponseWriter, r *stdhttp.Request) (authz.Principal, bool) {
	p, ok := httpauth.PrincipalFrom(r.Context())
	if !ok {
		httpauth.WriteProblem(w, r, apierror.New(apierror.AuthenticationRequired, "A valid access token is required."))
	}
	return p, ok
}

// describe names the action for the audit entry. The tenant is named only
// when it is one of the caller's own (Q38 38.10), so a 404 for another
// tenant's records leaves no tenant in the log.
// A 404 never names a tenant at all (Q38 38.10): fail clears it.
func describe(r *stdhttp.Request, p authz.Principal, action, resourceType, resourceID, tenant string) noted {
	own := ""
	for _, t := range p.Tenants() {
		if t == tenant {
			own = tenant
		}
	}
	audit.Describe(r.Context(), action, resourceType, resourceID, own)
	return noted{action: action, resourceType: resourceType, resourceID: resourceID}
}

// noted is what describe recorded for the request's audit entry.
type noted struct{ action, resourceType, resourceID string }

func (h *Handler) fail(w stdhttp.ResponseWriter, r *stdhttp.Request, n noted, err error) {
	if errors.Is(err, app.ErrNotFound) {
		audit.Describe(r.Context(), n.action, n.resourceType, n.resourceID, "")
	}
	var inv *app.InvalidError
	switch {
	case errors.As(err, &inv):
		httpauth.WriteProblem(w, r, apierror.Validation("The request is not valid.", apierror.FieldError{Field: inv.Field, Reason: inv.Reason}))
	case errors.Is(err, app.ErrNotFound):
		httpauth.WriteProblem(w, r, apierror.New(apierror.ResourceNotFound, detailNotFound))
	case errors.Is(err, app.ErrForbidden):
		httpauth.WriteProblem(w, r, apierror.New(apierror.PermissionDenied,
			"Only an owner whose own grant covers it can do this; owner roles come only from tenant provisioning."))
	case errors.Is(err, app.ErrSoD):
		httpauth.WriteProblem(w, r, apierror.New(apierror.SoDConflict, "Maker, checker and member must be three different people."))
	case errors.Is(err, app.ErrDelegation):
		httpauth.WriteProblem(w, r, apierror.New(apierror.DelegationExceeded,
			"Your own owner grant does not cover this scope or ends sooner (never grant above the delegator)."))
	case errors.Is(err, app.ErrStepUp):
		httpauth.WriteProblem(w, r, apierror.New(apierror.StepUpRequired,
			"Approvals and revocations need step-up authentication, which is not available yet on this deployment."))
	case errors.Is(err, app.ErrVersion):
		httpauth.WriteProblem(w, r, apierror.New(apierror.VersionConflict, "The request has changed. Read it again and retry."))
	case errors.Is(err, app.ErrState):
		httpauth.WriteProblem(w, r, apierror.New(apierror.OperationStateConflict,
			"Not allowed now: already decided, expired, revoked, or the member already holds this role."))
	case errors.Is(err, app.ErrInProgress):
		httpauth.WriteProblem(w, r, apierror.New(apierror.OperationInProgress, "The same Idempotency-Key is still being processed."))
	case errors.Is(err, app.ErrKeyReuse):
		httpauth.WriteProblem(w, r, apierror.New(apierror.IdempotencyFingerprintMismatch, "This Idempotency-Key was used with a different request."))
	default:
		h.log.ErrorContext(r.Context(), "grant administration failed", "trace_id", trace.ID(r.Context()), "error", err)
		httpauth.WriteProblem(w, r, apierror.New(apierror.TemporarilyUnavailable,
			"The service is temporarily unavailable. Retry later and quote the trace ID if it persists."))
	}
}

func idemKey(w stdhttp.ResponseWriter, r *stdhttp.Request, header string) (idempotency.Key, bool) {
	k, err := idempotency.ParseHeader([]string{header})
	if err != nil {
		httpauth.WriteProblem(w, r, apierror.New(apierror.IdempotencyKeyRequired, `Send Idempotency-Key as a quoted UUID, for example "…".`))
		return "", false
	}
	return k, true
}

var etagFormat = regexp.MustCompile(`^"access-request-v([1-9][0-9]{0,17})"$`)

func requestETag(version int64) string { return fmt.Sprintf(`"access-request-v%d"`, version) }

func parseIfMatch(w stdhttp.ResponseWriter, r *stdhttp.Request, v string) (int64, bool) {
	m := etagFormat.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		httpauth.WriteProblem(w, r, apierror.New(apierror.VersionConflict, "If-Match does not name a version of this request."))
		return 0, false
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	return n, err == nil
}

// readJSON decodes a JSON body strictly: unknown fields are refused.
func readJSON(w stdhttp.ResponseWriter, r *stdhttp.Request, v any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		httpauth.WriteProblem(w, r, apierror.Validation("The request body is not valid JSON for this operation."))
		return false
	}
	return true
}

func writeJSON(w stdhttp.ResponseWriter, status int, etag string, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if etag != "" {
		w.Header().Set("ETag", etag)
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func status(created bool) int {
	if created {
		return stdhttp.StatusCreated
	}
	return stdhttp.StatusOK // a replay (04-08)
}

// CreateInvitation serves POST /v1/tenants/{tenant_id}/invitations.
func (h *Handler) CreateInvitation(w stdhttp.ResponseWriter, r *stdhttp.Request, tenantID publicapi.TenantId, params publicapi.CreateInvitationParams) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	n := describe(r, p, "createInvitation", "tenant", tenantID, tenantID)
	key, ok := idemKey(w, r, params.IdempotencyKey)
	if !ok {
		return
	}
	inv, created, err := h.grants.CreateInvitation(r.Context(), p, tenantID, key)
	if err != nil {
		h.fail(w, r, n, err)
		return
	}
	writeJSON(w, status(created), "", wireInvitation(inv))
}

// ListInvitations serves GET /v1/tenants/{tenant_id}/invitations.
func (h *Handler) ListInvitations(w stdhttp.ResponseWriter, r *stdhttp.Request, tenantID publicapi.TenantId) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	n := describe(r, p, "listInvitations", "tenant", tenantID, tenantID)
	list, err := h.grants.ListInvitations(r.Context(), p, tenantID)
	if err != nil {
		h.fail(w, r, n, err)
		return
	}
	out := publicapi.InvitationList{Object: "list", Data: make([]publicapi.Invitation, 0, len(list))}
	for _, i := range list {
		out.Data = append(out.Data, wireInvitation(i))
	}
	writeJSON(w, stdhttp.StatusOK, "", out)
}

// AcceptInvitation serves POST /v1/invitations/accept.
func (h *Handler) AcceptInvitation(w stdhttp.ResponseWriter, r *stdhttp.Request, params publicapi.AcceptInvitationParams) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	audit.Describe(r.Context(), "acceptInvitation", "", "", "") // the invitee is not a member yet: no tenant (Q38 38.10)
	n := noted{action: "acceptInvitation"}
	key, ok := idemKey(w, r, params.IdempotencyKey)
	if !ok {
		return
	}
	var body publicapi.InvitationAcceptance
	if !readJSON(w, r, &body) {
		return
	}
	inv, err := h.grants.AcceptInvitation(r.Context(), p, body.Token, key)
	if err != nil {
		h.fail(w, r, n, err)
		return
	}
	audit.Describe(r.Context(), "acceptInvitation", "invitation", inv.ID, "")
	writeJSON(w, stdhttp.StatusOK, "", wireInvitation(inv))
}

// CreateAccessRequest serves POST /v1/tenants/{tenant_id}/access_requests.
func (h *Handler) CreateAccessRequest(w stdhttp.ResponseWriter, r *stdhttp.Request, tenantID publicapi.TenantId, params publicapi.CreateAccessRequestParams) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	n := describe(r, p, "createAccessRequest", "tenant", tenantID, tenantID)
	key, ok := idemKey(w, r, params.IdempotencyKey)
	if !ok {
		return
	}
	var body publicapi.AccessRequestCreate
	if !readJSON(w, r, &body) {
		return
	}
	persona, known := personaFromWire(string(body.Persona))
	if !known {
		httpauth.WriteProblem(w, r, apierror.Validation("The request is not valid.", apierror.FieldError{Field: "persona", Reason: "unknown persona"}))
		return
	}
	in := app.RequestInput{InvitationID: deref(body.InvitationId), MembershipID: deref(body.MembershipId), MerchantID: deref(body.MerchantId),
		Persona: persona, EffectiveFrom: body.EffectiveFrom, ExpiresAt: body.ExpiresAt, Purpose: body.Purpose}
	ar, created, err := h.grants.CreateAccessRequest(r.Context(), p, tenantID, in, key)
	if err != nil {
		h.fail(w, r, n, err)
		return
	}
	describe(r, p, "createAccessRequest", "access_request", ar.ID, tenantID)
	writeJSON(w, status(created), requestETag(ar.Version), wireRequest(ar))
}

// ListAccessRequests serves GET /v1/tenants/{tenant_id}/access_requests.
func (h *Handler) ListAccessRequests(w stdhttp.ResponseWriter, r *stdhttp.Request, tenantID publicapi.TenantId, params publicapi.ListAccessRequestsParams) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	n := describe(r, p, "listAccessRequests", "tenant", tenantID, tenantID)
	var filter domain.RequestStatus
	if params.Status != nil {
		if !params.Status.Valid() {
			httpauth.WriteProblem(w, r, apierror.Validation("The request is not valid.", apierror.FieldError{Field: "status", Reason: "unknown status"}))
			return
		}
		filter = domain.RequestStatus(strings.ToUpper(string(*params.Status)))
	}
	list, err := h.grants.ListAccessRequests(r.Context(), p, tenantID, filter)
	if err != nil {
		h.fail(w, r, n, err)
		return
	}
	out := publicapi.AccessRequestList{Object: "list", Data: make([]publicapi.AccessRequest, 0, len(list))}
	for _, a := range list {
		out.Data = append(out.Data, wireRequest(a))
	}
	writeJSON(w, stdhttp.StatusOK, "", out)
}

// ApproveAccessRequest serves POST …/access_requests/{access_request_id}/approval.
func (h *Handler) ApproveAccessRequest(w stdhttp.ResponseWriter, r *stdhttp.Request, tenantID publicapi.TenantId,
	requestID publicapi.AccessRequestId, params publicapi.ApproveAccessRequestParams) {
	h.decide(w, r, tenantID, requestID, params.IfMatch, params.IdempotencyKey, true)
}

// RejectAccessRequest serves POST …/access_requests/{access_request_id}/rejection.
func (h *Handler) RejectAccessRequest(w stdhttp.ResponseWriter, r *stdhttp.Request, tenantID publicapi.TenantId,
	requestID publicapi.AccessRequestId, params publicapi.RejectAccessRequestParams) {
	h.decide(w, r, tenantID, requestID, params.IfMatch, params.IdempotencyKey, false)
}

func (h *Handler) decide(w stdhttp.ResponseWriter, r *stdhttp.Request, tenantID, requestID, ifMatch, idem string, approve bool) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	action := "rejectAccessRequest"
	if approve {
		action = "approveAccessRequest"
	}
	n := describe(r, p, action, "access_request", requestID, tenantID)
	version, ok := parseIfMatch(w, r, ifMatch)
	if !ok {
		return
	}
	key, ok := idemKey(w, r, idem)
	if !ok {
		return
	}
	d := app.Decision{Approve: approve, Version: version}
	if !approve {
		var body publicapi.Decision
		if !readJSON(w, r, &body) {
			return
		}
		d.Reason = body.Reason
	}
	ar, err := h.grants.Decide(r.Context(), p, tenantID, requestID, d, key)
	if err != nil {
		h.fail(w, r, n, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, requestETag(ar.Version), wireRequest(ar))
}

// ListMemberships serves GET /v1/tenants/{tenant_id}/memberships.
func (h *Handler) ListMemberships(w stdhttp.ResponseWriter, r *stdhttp.Request, tenantID publicapi.TenantId) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	n := describe(r, p, "listMemberships", "tenant", tenantID, tenantID)
	list, err := h.grants.ListMemberships(r.Context(), p, tenantID)
	if err != nil {
		h.fail(w, r, n, err)
		return
	}
	out := publicapi.MembershipList{Object: "list", Data: make([]publicapi.Membership, 0, len(list))}
	for _, m := range list {
		out.Data = append(out.Data, wireMembership(m))
	}
	writeJSON(w, stdhttp.StatusOK, "", out)
}

// RevokeMembership serves POST …/memberships/{membership_id}/revocation.
func (h *Handler) RevokeMembership(w stdhttp.ResponseWriter, r *stdhttp.Request, tenantID publicapi.TenantId,
	membershipID publicapi.MembershipId, params publicapi.RevokeMembershipParams) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	n := describe(r, p, "revokeMembership", "membership", membershipID, tenantID)
	key, ok := idemKey(w, r, params.IdempotencyKey)
	if !ok {
		return
	}
	var body publicapi.Decision
	if !readJSON(w, r, &body) {
		return
	}
	m, err := h.grants.Revoke(r.Context(), p, tenantID, membershipID, body.Reason, key)
	if err != nil {
		h.fail(w, r, n, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, "", wireMembership(m))
}

// --- wire mapping (lower case on the wire, ADR 0001) ----------------------------

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func wirePerson(p domain.Person) publicapi.Person {
	return publicapi.Person{Issuer: p.Issuer, Subject: p.Subject}
}

func wirePersonPtr(p *domain.Person) *publicapi.Person {
	if p == nil {
		return nil
	}
	w := wirePerson(*p)
	return &w
}

func personaFromWire(s string) (domain.Persona, bool) {
	switch s {
	case "mown", "mops", "mfin", "mdev", "mview":
		return domain.Persona(strings.ToUpper(s)), true
	}
	return "", false
}

func utc(t time.Time) time.Time { return t.UTC().Truncate(time.Millisecond) }

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := utc(*t)
	return &u
}

func wireInvitation(i app.Invitation) publicapi.Invitation {
	return publicapi.Invitation{Object: "invitation", Id: i.ID, TenantId: i.TenantID, Status: publicapi.InvitationStatus(i.Status),
		InvitedBy: wirePerson(i.InvitedBy), AcceptedBy: wirePersonPtr(i.AcceptedBy), CreatedAt: utc(i.CreatedAt),
		ExpiresAt: utc(i.ExpiresAt), AcceptedAt: utcPtr(i.AcceptedAt), Token: optional(i.Token)}
}

func wireRequest(a app.AccessRequest) publicapi.AccessRequest {
	return publicapi.AccessRequest{Object: "access_request", Id: a.ID, TenantId: a.TenantID, Member: wirePerson(a.Member),
		MerchantId: optional(a.MerchantID), Persona: publicapi.DelegablePersona(strings.ToLower(string(a.Persona))),
		EffectiveFrom: utc(a.EffectiveFrom), ExpiresAt: utc(a.ExpiresAt), Purpose: a.Purpose,
		Status: publicapi.AccessRequestStatus(strings.ToLower(string(a.Status))), RequestedBy: wirePerson(a.Maker),
		RequestedAt: utc(a.RequestedAt), DecisionDueAt: utc(a.DecisionDue), DecidedBy: wirePersonPtr(a.DecidedBy),
		DecidedAt: utcPtr(a.DecidedAt), DecisionReason: optional(a.DecisionReason), MembershipId: optional(a.MembershipID), Version: a.Version}
}

func wireMembership(m app.Membership) publicapi.Membership {
	return publicapi.Membership{Object: "membership", Id: m.ID, TenantId: m.TenantID, Member: wirePerson(m.Member),
		MerchantId: optional(m.MerchantID), Persona: publicapi.MembershipPersona(strings.ToLower(string(m.Persona))),
		EffectiveFrom: utc(m.EffectiveFrom), ExpiresAt: utc(m.ExpiresAt), GrantedBy: wirePerson(m.GrantedBy),
		ApprovedBy: wirePerson(m.ApprovedBy), GrantedAt: utc(m.GrantedAt), RevokedBy: wirePersonPtr(m.RevokedBy),
		RevokedAt: utcPtr(m.RevokedAt), AccessRequestId: optional(m.AccessRequestID)}
}
