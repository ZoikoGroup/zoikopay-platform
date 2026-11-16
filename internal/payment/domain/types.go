package domain

import (
	"errors"
	"time"
)

// Status is the canonical intent_status (06-01 §2.1), upper case internally.
type Status string

// The 06-01 v1 intent statuses.
const (
	RequiresPaymentMethod  Status = "REQUIRES_PAYMENT_METHOD"
	RequiresConfirmation   Status = "REQUIRES_CONFIRMATION"
	RequiresCustomerAction Status = "REQUIRES_CUSTOMER_ACTION"
	Processing             Status = "PROCESSING"
	RequiresCapture        Status = "REQUIRES_CAPTURE"
	PartiallyCaptured      Status = "PARTIALLY_CAPTURED"
	Succeeded              Status = "SUCCEEDED"
	Failed                 Status = "FAILED"
	Canceled               Status = "CANCELED"
	Expired                Status = "EXPIRED"
)

// Terminal reports whether no new primary execution may happen (06-01 §2).
func (s Status) Terminal() bool {
	return s == Succeeded || s == Failed || s == Canceled || s == Expired
}

// CaptureMethod is AUTOMATIC or MANUAL (06-01 §3.1).
type CaptureMethod string

// Capture methods.
const (
	Automatic CaptureMethod = "AUTOMATIC"
	Manual    CaptureMethod = "MANUAL"
)

// OpKind is the kind of effectful operation. Refunds are a separate
// aggregate (06-01 §8.3) and not part of this package yet.
type OpKind string

// Operation kinds.
const (
	OpConfirm OpKind = "CONFIRM"
	OpCapture OpKind = "CAPTURE"
	OpVoid    OpKind = "VOID"
)

// Resolution is an operation's outcome resolution (06-01 §2).
type Resolution string

// The five resolutions.
const (
	ResPending    Resolution = "PENDING"
	ResUnknown    Resolution = "UNKNOWN"
	ResPositive   Resolution = "CERTAIN_POSITIVE"
	ResNegative   Resolution = "CERTAIN_NEGATIVE"
	ResConflicted Resolution = "CONFLICTED"
)

// Unresolved reports whether the operation still blocks new effects.
func (r Resolution) Unresolved() bool {
	return r == ResPending || r == ResUnknown || r == ResConflicted
}

// AttemptStatus is the provider-facing attempt status (06-01 §2.2).
type AttemptStatus string

// Attempt statuses.
const (
	AttemptReserved       AttemptStatus = "RESERVED"
	AttemptDispatching    AttemptStatus = "DISPATCHING"
	AttemptActionRequired AttemptStatus = "ACTION_REQUIRED"
	AttemptPending        AttemptStatus = "PENDING"
	AttemptAuthorized     AttemptStatus = "AUTHORIZED"
	AttemptSucceeded      AttemptStatus = "SUCCEEDED"
	AttemptDeclined       AttemptStatus = "DECLINED"
	AttemptNoEffect       AttemptStatus = "NO_EFFECT"
	AttemptUnknown        AttemptStatus = "UNKNOWN"
)

// Input names a reducer input; recorded in the transition audit. Names are
// the 06-01 §5 matrix inputs.
type Input string

// Command inputs (06-01 §5).
const (
	InCreate               Input = "CREATE"
	InAttachToken          Input = "ATTACH_TOKEN"
	InConfirm              Input = "CONFIRM"
	InCaptureRequest       Input = "CAPTURE_REQUEST"
	InCancelBeforeDispatch Input = "CANCEL_BEFORE_DISPATCH"
	InCancelAfterDispatch  Input = "CANCEL_AFTER_DISPATCH"
	InVoidAuthRequest      Input = "VOID_AUTH_REQUEST"
	InExpirePreConfirm     Input = "EXPIRE_PRE_CONFIRM"
	InExpireProcessing     Input = "EXPIRE_PROCESSING"
)

// Outcome is a normalized provider observation produced by BC-04 (06-01 §5,
// §7). Payments never sees raw provider statuses (PI-INV-21).
type Outcome string

// Normalized outcomes, named as the 06-01 §5 matrix inputs.
const (
	ProviderChallenge         Outcome = "PROVIDER_CHALLENGE"
	CustomerActionComplete    Outcome = "CUSTOMER_ACTION_COMPLETE"
	CustomerActionExpired     Outcome = "CUSTOMER_ACTION_EXPIRED"
	ProviderAuthorized        Outcome = "PROVIDER_AUTHORIZED"
	ProviderExecutionSuccess  Outcome = "PROVIDER_EXECUTION_SUCCESS"
	ProviderDeclinedRetryable Outcome = "PROVIDER_DECLINED_RETRYABLE"
	ProviderDeclinedFinal     Outcome = "PROVIDER_DECLINED_FINAL"
	ProviderPending           Outcome = "PROVIDER_PENDING"
	ProviderOutcomeUnknown    Outcome = "PROVIDER_OUTCOME_UNKNOWN"
	ProviderNoEffectProven    Outcome = "PROVIDER_NO_EFFECT_PROVEN"
	CaptureConfirmedFinal     Outcome = "CAPTURE_CONFIRMED_FINAL"
	CaptureFailedNoEffect     Outcome = "CAPTURE_FAILED_NO_EFFECT"
	CaptureUnknown            Outcome = "CAPTURE_UNKNOWN"
	VoidConfirmed             Outcome = "VOID_CONFIRMED"
	AuthExpiredUncaptured     Outcome = "AUTH_EXPIRED_UNCAPTURED"
)

// KnownOutcome reports whether o is one of the normalized outcomes.
func KnownOutcome(o Outcome) bool {
	switch o {
	case ProviderChallenge, CustomerActionComplete, CustomerActionExpired, ProviderAuthorized,
		ProviderExecutionSuccess, ProviderDeclinedRetryable, ProviderDeclinedFinal, ProviderPending,
		ProviderOutcomeUnknown, ProviderNoEffectProven, CaptureConfirmedFinal, CaptureFailedNoEffect,
		CaptureUnknown, VoidConfirmed, AuthExpiredUncaptured:
		return true
	}
	return false
}

// Operation is the reducer's view of one effectful operation.
type Operation struct {
	ID         string // public op_ id
	Kind       OpKind
	Resolution Resolution
	Requested  int64 // minor units
}

// Intent is the reducer's view of the aggregate.
type Intent struct {
	Status          Status
	Version         int64
	CaptureMethod   CaptureMethod
	Requested       int64 // minor units
	Currency        string
	Authorized      int64
	Captured        int64
	Reserved        int64
	HasToken        bool
	Active          *Operation // the unresolved operation, if any
	CancelRequested bool
	Frozen          bool
	ExpiryFlagged   bool
	ExpiresAt       time.Time // zero: no business deadline
}

// Available is authorized − captured − reserved (06-01 §8.1).
func (i Intent) Available() int64 { return i.Authorized - i.Captured - i.Reserved }

// Errors returned by commands. The app layer maps them to 04-01 problem codes.
var (
	ErrInvalid         = errors.New("invalid payment command")
	ErrStateConflict   = errors.New("transition not allowed from the current status")
	ErrActiveOperation = errors.New("an effectful operation is still unresolved")
	ErrFrozen          = errors.New("intent is frozen pending recovery of conflicting evidence")
	ErrCapability      = errors.New("capability not enabled for this payment")
	ErrRevision        = errors.New("expected revision does not match")
	ErrNotCancelable   = errors.New("a captured payment cannot be canceled; use a refund")
)
