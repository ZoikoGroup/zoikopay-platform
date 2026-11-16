package domain

import (
	"fmt"
	"time"
)

// Step is one applied input: it advances the aggregate version by one and
// produces one transition-audit row (06-01 §5: "the reducer is the ONLY
// state mutation authority").
type Step struct {
	Input Input
	From  Status
	To    Status
}

// Emit names an outbox event to write in the same transaction (04-06 registry).
type Emit string

// Events BC-03 publishes (04-06 §5 rows 05, 07, 10, 11, 12).
const (
	EmitIntentCreated          Emit = "payment.intent.created.v1"
	EmitAttemptRequested       Emit = "payment.attempt.requested.v1"
	EmitAuthorizationConfirmed Emit = "payment.authorization.confirmed.v1"
	EmitCaptureConfirmed       Emit = "payment.capture.confirmed.v1"
	EmitOutcomeUnknown         Emit = "payment.outcome.unknown.v1"
)

// Disposition is what the reducer did with an observation.
type Disposition string

// Observation dispositions (stored with every observation).
const (
	Applied         Disposition = "APPLIED"
	Recorded        Disposition = "RECORDED" // evidence kept, no state change required
	Duplicate       Disposition = "DUPLICATE"
	IgnoredTerminal Disposition = "IGNORED_TERMINAL"
	Quarantined     Disposition = "QUARANTINED"
	Conflict        Disposition = "CONFLICT"
)

// CaseReason opens a recovery case (06-01 §7.3 R5).
type CaseReason string

// Recovery case reasons.
const (
	CaseUnresolved   CaseReason = "UNRESOLVED_OPERATION"
	CaseConflict     CaseReason = "CONFLICTING_EVIDENCE"
	CaseQuarantine   CaseReason = "QUARANTINED_OBSERVATION"
	CaseExpiredUnres CaseReason = "EXPIRED_WITH_UNRESOLVED_EFFECT"
)

// NewOperation asks the app layer to create an operation and attempt.
type NewOperation struct {
	Kind      OpKind
	Requested int64
}

// Decision is the complete, deterministic result of one command or observation.
// The app layer persists it atomically with CAS (PI-INV-07, -08).
type Decision struct {
	Steps []Step
	Next  Intent // the aggregate after Steps (Version advanced by len(Steps))

	NewOp           *NewOperation // operation to create (becomes Next.Active)
	OpResolution    Resolution    // new resolution of the observed/active operation ("" = unchanged)
	AttemptStatus   AttemptStatus // new attempt status ("" = unchanged)
	ClearToken      bool
	SetToken        bool
	SetAction       bool // set action_ref/expiry from the observation
	ClearAction     bool
	FlagExpiry      bool
	Emits           []Emit
	Disposition     Disposition // for observations
	Case            CaseReason  // "" = none
	Reason          string      // status_reason_code / audit reason
	CaptureAmount   int64       // for payment.capture.confirmed
	AuthorizeAmount int64       // for payment.authorization.confirmed
}

func (d *Decision) step(in Input, to Status) {
	d.Steps = append(d.Steps, Step{Input: in, From: d.Next.Status, To: to})
	d.Next.Status = to
	d.Next.Version++
}

// ---------------------------------------------------------------------------
// Commands (06-01 §6).

// CreateParams are the validated, server-scoped inputs of create_intent.
type CreateParams struct {
	Amount        int64
	Currency      string
	CaptureMethod CaptureMethod
	HasToken      bool
	ExpiresAt     time.Time
	Now           time.Time
}

// Create applies CREATE and, because the pilot profile requires a vault token
// at creation (04-02 §6.1), ATTACH_TOKEN in the same transaction.
func Create(p CreateParams) (Decision, error) {
	switch {
	case p.Amount <= 0:
		return Decision{}, fmt.Errorf("%w: amount_minor must be positive", ErrInvalid)
	case p.CaptureMethod != Automatic && p.CaptureMethod != Manual:
		return Decision{}, fmt.Errorf("%w: capture_method must be automatic or manual", ErrInvalid)
	case !p.HasToken:
		return Decision{}, fmt.Errorf("%w: payment_method_token is required (04-02 §6.1 pilot profile)", ErrInvalid)
	case !p.ExpiresAt.IsZero() && !p.ExpiresAt.After(p.Now):
		return Decision{}, fmt.Errorf("%w: expires_at must be in the future", ErrInvalid)
	}
	d := Decision{Next: Intent{CaptureMethod: p.CaptureMethod, Requested: p.Amount, Currency: p.Currency, ExpiresAt: p.ExpiresAt}}
	d.step(InCreate, RequiresPaymentMethod)
	d.SetToken, d.Next.HasToken = true, true
	d.step(InAttachToken, RequiresConfirmation)
	d.Emits = []Emit{EmitIntentCreated}
	return d, nil
}

func guardEffect(i Intent, expected int64) error {
	if expected != 0 && expected != i.Version {
		return fmt.Errorf("%w: expected %d, current %d", ErrRevision, expected, i.Version)
	}
	if i.Frozen {
		return ErrFrozen
	}
	if i.Active != nil {
		return fmt.Errorf("%w: %s", ErrActiveOperation, i.Active.ID)
	}
	return nil
}

// Confirm applies CONFIRM (and ATTACH_TOKEN first when a new token is
// supplied after a retryable decline, 06-01 trace T4).
func Confirm(i Intent, expected int64, newToken bool, now time.Time) (Decision, error) {
	if err := guardEffect(i, expected); err != nil {
		return Decision{}, err
	}
	if !i.ExpiresAt.IsZero() && !now.Before(i.ExpiresAt) {
		return Decision{}, fmt.Errorf("%w: intent passed its expires_at", ErrStateConflict)
	}
	d := Decision{Next: i}
	if newToken {
		if i.Status != RequiresPaymentMethod {
			return Decision{}, fmt.Errorf("%w: a new payment method can be attached only in %s", ErrStateConflict, RequiresPaymentMethod)
		}
		d.SetToken, d.Next.HasToken = true, true
		d.step(InAttachToken, RequiresConfirmation)
	}
	if d.Next.Status != RequiresConfirmation {
		return Decision{}, fmt.Errorf("%w: confirm needs %s, intent is %s", ErrStateConflict, RequiresConfirmation, d.Next.Status)
	}
	if !d.Next.HasToken {
		return Decision{}, fmt.Errorf("%w: no payment method attached", ErrStateConflict)
	}
	d.step(InConfirm, Processing)
	d.NewOp = &NewOperation{Kind: OpConfirm, Requested: i.Requested}
	d.Emits = []Emit{EmitAttemptRequested}
	return d, nil
}

// Capture applies CAPTURE_REQUEST (06-01 §5.2, §8.1). Partial and multiple
// capture are disabled by the pilot default (06-01 §7.4, PI-028), so the
// amount must equal the whole available authorization.
func Capture(i Intent, expected int64, amount int64) (Decision, error) {
	if err := guardEffect(i, expected); err != nil {
		return Decision{}, err
	}
	if i.Status == PartiallyCaptured {
		return Decision{}, fmt.Errorf("%w: multiple capture is disabled (06-01 §7.4)", ErrCapability)
	}
	if i.Status != RequiresCapture || i.CaptureMethod != Manual {
		return Decision{}, fmt.Errorf("%w: capture needs a manual-capture intent in %s, intent is %s", ErrStateConflict, RequiresCapture, i.Status)
	}
	if amount <= 0 {
		return Decision{}, fmt.Errorf("%w: capture amount_minor must be positive", ErrInvalid)
	}
	avail := i.Available()
	if amount > avail {
		return Decision{}, fmt.Errorf("%w: capture %d exceeds available authorization %d", ErrInvalid, amount, avail)
	}
	if amount != avail {
		return Decision{}, fmt.Errorf("%w: partial capture is disabled; capture the full %d", ErrCapability, avail)
	}
	d := Decision{Next: i}
	d.Next.Reserved += amount
	d.step(InCaptureRequest, RequiresCapture)
	d.NewOp = &NewOperation{Kind: OpCapture, Requested: amount}
	d.Emits = []Emit{EmitAttemptRequested}
	return d, nil
}

// Cancel applies the 06-01 §8.2 cancellation rules.
func Cancel(i Intent, expected int64) (Decision, error) {
	if expected != 0 && expected != i.Version {
		return Decision{}, fmt.Errorf("%w: expected %d, current %d", ErrRevision, expected, i.Version)
	}
	if i.Frozen {
		return Decision{}, ErrFrozen
	}
	d := Decision{Next: i}
	switch i.Status {
	case RequiresConfirmation:
		if i.Active != nil {
			return Decision{}, fmt.Errorf("%w: %s", ErrActiveOperation, i.Active.ID)
		}
		d.step(InCancelBeforeDispatch, Canceled)
		d.Reason = "CANCELED_BEFORE_DISPATCH"
	case Processing, RequiresCustomerAction:
		// Instruction in flight: record the request, never cancel yet (§8.2).
		if i.CancelRequested {
			return Decision{}, fmt.Errorf("%w: cancellation already requested", ErrStateConflict)
		}
		d.Next.CancelRequested = true
		d.step(InCancelAfterDispatch, i.Status)
		d.Reason = "CANCEL_REQUESTED_AWAITING_PROVIDER"
	case RequiresCapture:
		if i.Active != nil {
			// Capture vs void race: inquiry first, no premature void (§9.2).
			return Decision{}, fmt.Errorf("%w: %s", ErrActiveOperation, i.Active.ID)
		}
		d.step(InVoidAuthRequest, RequiresCapture)
		d.NewOp = &NewOperation{Kind: OpVoid, Requested: i.Authorized - i.Captured}
		d.Emits = []Emit{EmitAttemptRequested}
		d.Reason = "VOID_REQUESTED"
	case Succeeded, PartiallyCaptured:
		return Decision{}, ErrNotCancelable
	default:
		return Decision{}, fmt.Errorf("%w: cannot cancel in %s", ErrStateConflict, i.Status)
	}
	return d, nil
}

// Expire applies the business deadline (06-01 §5.1 EXPIRE_*). It returns
// ok=false when nothing applies.
func Expire(i Intent, now time.Time) (Decision, bool) {
	if i.ExpiresAt.IsZero() || now.Before(i.ExpiresAt) || i.Status.Terminal() {
		return Decision{}, false
	}
	d := Decision{Next: i}
	switch {
	case (i.Status == RequiresPaymentMethod || i.Status == RequiresConfirmation) && i.Active == nil:
		d.step(InExpirePreConfirm, Expired)
		d.Reason = "EXPIRED_BEFORE_CONFIRMATION"
		return d, true
	case (i.Status == Processing || i.Status == RequiresCustomerAction) && !i.ExpiryFlagged:
		// Flag only: finalization continues until proof (EXPIRE_PROCESSING).
		d.FlagExpiry, d.Next.ExpiryFlagged = true, true
		d.step(InExpireProcessing, i.Status)
		d.Case = CaseExpiredUnres
		d.Reason = "EXPIRY_PASSED_WITH_UNRESOLVED_EFFECT"
		return d, true
	}
	return Decision{}, false
}
