package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/payment/domain"
	"github.com/zoiko/zoikopay/internal/platform/apierror"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/idempotency"
	"github.com/zoiko/zoikopay/internal/platform/ids"
	"github.com/zoiko/zoikopay/internal/platform/outbox"
)

// Schema is BC-03's PostgreSQL schema.
const Schema = "payment"

// Scope is the server-derived authority of one call (06-01 §6.1 steps 1–3).
// The caller (the gateway's authorization adapter) resolves it from verified
// claims; nothing here comes from the request body.
type Scope struct {
	Environment   string // TEST or LIVE
	CellID        string
	LegalEntityID string // operating entity
	TenantID      string
	MerchantID    string
	ClientID      string // API client / application
	PrincipalID   string // actor subject
	RequestID     string
	CorrelationID string
}

func (s Scope) tenant() db.Tenant {
	return db.Tenant{Environment: s.Environment, CellID: s.CellID, LegalEntityID: s.LegalEntityID, TenantID: s.TenantID}
}

func (s Scope) valid() bool {
	return s.tenant().TenantID != "" && s.CellID != "" && s.LegalEntityID != "" && s.MerchantID != "" &&
		s.ClientID != "" && s.PrincipalID != "" && (s.Environment == "TEST" || s.Environment == "LIVE")
}

// Action is the effect an eligibility decision is asked about.
type Action string

// Actions checked at the effect point (06-01 PI-INV-17, PI-015).
const (
	ActionCreate  Action = "payment_intent.create"
	ActionConfirm Action = "payment_intent.confirm"
	ActionCapture Action = "payment_intent.capture"
	ActionCancel  Action = "payment_intent.cancel"
)

// PolicyRequest describes the payment the decision is about.
type PolicyRequest struct {
	Amount        int64
	Currency      string
	CaptureMethod domain.CaptureMethod
	IntentID      string // public id, empty on create
}

// PolicyDecision is a signed, versioned decision from BC-02 (03-03 §3).
type PolicyDecision struct {
	Allowed       bool
	PolicyVersion string
	ReasonCode    string
}

// Eligibility is BC-02's enforcement adapter. It is called outside the
// database transaction, immediately before each effect. Errors fail closed.
type Eligibility interface {
	Decide(ctx context.Context, sc Scope, a Action, r PolicyRequest) (PolicyDecision, error)
}

// ErrTokenRejected is returned by a TokenVault for a token that is not valid
// for this tenant, merchant, cell or usage.
var ErrTokenRejected = errors.New("payment method token rejected by the vault")

// TokenVault validates payment-method token references at the approved vault
// boundary (04-02 §5.2). Payments stores only the reference (PI-004).
type TokenVault interface {
	Verify(ctx context.Context, sc Scope, tokenRef string) error
}

// Service runs BC-03's use cases. Every command is one tenant transaction:
// idempotency reservation, reducer, CAS update, audit and outbox commit
// together, and no network call happens inside it (06-01 §6.1, §9.1).
type Service struct {
	Pool        *pgxpool.Pool // zp_execution
	Eligibility Eligibility
	Vault       TokenVault
	Now         func() time.Time
	IDs         ids.Generator
	Log         *slog.Logger
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.New(slog.DiscardHandler)
}

func (s *Service) registry() idempotency.Registry {
	return idempotency.Registry{Schema: Schema, Now: s.Now}
}

func (s *Service) writer() outbox.Writer { return outbox.Writer{Schema: Schema, Now: s.Now} }

func source(cell string) string { return "/zoikopay/" + cell + "/bc03" }

// errNotFound is returned for absent or out-of-scope resources (masked 404).
var errNotFound = errors.New("payment resource not found")

// problem maps errors to 04-01 §8 problem details.
func problem(err error) *apierror.Problem {
	var p *apierror.Problem
	switch {
	case err == nil:
		return nil
	case errors.As(err, &p):
		return p
	case errors.Is(err, errNotFound), errors.Is(err, pgx.ErrNoRows):
		return apierror.New(apierror.ResourceNotFound, "No such payment resource.")
	case errors.Is(err, domain.ErrInvalid):
		return apierror.New(apierror.ValidationError, err.Error())
	case errors.Is(err, domain.ErrActiveOperation):
		return apierror.New(apierror.OperationInProgress, "An earlier operation on this payment is not resolved yet. Query it before retrying.")
	case errors.Is(err, domain.ErrStateConflict), errors.Is(err, domain.ErrRevision), errors.Is(err, domain.ErrFrozen),
		errors.Is(err, domain.ErrNotCancelable):
		return apierror.New(apierror.OperationStateConflict, err.Error())
	case errors.Is(err, domain.ErrCapability):
		return apierror.New(apierror.CapabilityNotAvailable, err.Error())
	case errors.Is(err, ErrTokenRejected):
		return apierror.New(apierror.ValidationError, "The payment method token is not valid for this merchant.")
	}
	return apierror.New(apierror.InternalError, "")
}

// Result is a command's HTTP-level outcome.
type Result struct {
	Status   int  // 200, 201 or 202
	Replayed bool // an identical retry returned the stored result
	Intent   *IntentView
	Op       *OperationView
}

// inTenant runs fn in a tenant transaction.
func (s *Service) inTenant(ctx context.Context, sc Scope, fn func(pgx.Tx) error) error {
	if !sc.valid() {
		return apierror.New(apierror.PermissionDenied, "Request scope is incomplete.")
	}
	if err := db.InTenantTx(ctx, s.Pool, sc.tenant(), fn); err != nil {
		var p *apierror.Problem
		if errors.As(err, &p) {
			return p
		}
		return unwrapTx(err)
	}
	return nil
}

// unwrapTx removes db.InTx's "transaction:" prefix while keeping wrapped sentinels.
func unwrapTx(err error) error { return fmt.Errorf("%w", err) }
