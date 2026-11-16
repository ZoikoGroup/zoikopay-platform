package domain

// Observation is a normalized, authenticated provider observation received
// from BC-04 (06-01 §7.1 step 5). BC-04 has already verified signatures and
// mapped provider strings; Payments checks it against the aggregate.
type Observation struct {
	Outcome       Outcome
	Amount        *int64 // evidence amount, required for positive money outcomes
	Currency      string
	RetryEligible bool // for PROVIDER_NO_EFFECT_PROVEN: may the merchant retry (policy, via BC-04)
	HasAction     bool // PROVIDER_CHALLENGE carries an action reference
}

// implied classifies an outcome as proving a positive result, a negative
// result, or neither.
func implied(o Outcome) Resolution {
	switch o {
	case ProviderAuthorized, ProviderExecutionSuccess, CaptureConfirmedFinal, VoidConfirmed:
		return ResPositive
	case ProviderDeclinedRetryable, ProviderDeclinedFinal, ProviderNoEffectProven, CaptureFailedNoEffect:
		return ResNegative
	}
	return ""
}

func fitsKind(k OpKind, o Outcome) bool {
	switch k {
	case OpConfirm:
		switch o {
		case ProviderChallenge, CustomerActionComplete, CustomerActionExpired, ProviderAuthorized,
			ProviderExecutionSuccess, ProviderDeclinedRetryable, ProviderDeclinedFinal, ProviderPending,
			ProviderOutcomeUnknown, ProviderNoEffectProven:
			return true
		}
	case OpCapture:
		switch o {
		case CaptureConfirmedFinal, CaptureFailedNoEffect, CaptureUnknown, ProviderPending, ProviderOutcomeUnknown:
			return true
		}
	case OpVoid:
		switch o {
		case VoidConfirmed, ProviderNoEffectProven, ProviderPending, ProviderOutcomeUnknown:
			return true
		}
	}
	return false
}

// Observe reduces one observation about operation op of intent i. It never
// errors: every observation is recorded with a disposition, and anything that
// cannot be applied safely is quarantined or marked as a conflict
// (06-01 §7.2, PI-INV-09, PI-022).
func Observe(i Intent, op Operation, ob Observation) Decision {
	d := Decision{Next: i}
	keep := func(disp Disposition, reason string, c CaseReason) Decision {
		d.Disposition, d.Reason, d.Case = disp, reason, c
		return d
	}
	if !KnownOutcome(ob.Outcome) {
		return keep(Quarantined, "UNKNOWN_OUTCOME_VALUE", CaseQuarantine)
	}

	// Provider proves an uncaptured authorization expired (06-01 §5.2).
	if ob.Outcome == AuthExpiredUncaptured {
		switch {
		case i.Status.Terminal():
			return keep(IgnoredTerminal, "INTENT_TERMINAL", "")
		case i.Status != RequiresCapture || i.Captured != 0:
			return keep(Quarantined, "AUTH_EXPIRY_NOT_APPLICABLE", CaseQuarantine)
		case i.Active != nil:
			// An unresolved capture or void may have had effect: never expire blindly.
			return keep(Recorded, "AUTH_EXPIRY_WITH_ACTIVE_OPERATION", CaseUnresolved)
		}
		d.step(Input(ob.Outcome), Expired)
		d.Disposition, d.Reason = Applied, "AUTHORIZATION_EXPIRED"
		return d
	}

	// Already resolved operation: duplicates and late evidence never move the
	// aggregate; contradictions freeze it (PI-INV-09, PI-AT-024, PI-AT-031).
	switch op.Resolution {
	case ResConflicted:
		return keep(Recorded, "OPERATION_CONFLICTED", "")
	case ResPositive, ResNegative:
		imp := implied(ob.Outcome)
		if imp == "" || imp == op.Resolution {
			return keep(Duplicate, "OPERATION_ALREADY_RESOLVED", "")
		}
		return conflict(d, "CONTRADICTS_RESOLVED_OPERATION")
	}

	if i.Status.Terminal() {
		return keep(IgnoredTerminal, "INTENT_TERMINAL", "")
	}
	if i.Active == nil || i.Active.ID != op.ID {
		return keep(Quarantined, "NOT_THE_ACTIVE_OPERATION", CaseQuarantine)
	}
	if !fitsKind(op.Kind, ob.Outcome) {
		return keep(Quarantined, "OUTCOME_DOES_NOT_FIT_OPERATION", CaseQuarantine)
	}
	if i.Frozen {
		return keep(Recorded, "INTENT_FROZEN", "")
	}

	// Positive money evidence must match exactly: partial authorization and
	// partial capture are disabled, so any difference is a conflict.
	if imp := implied(ob.Outcome); imp == ResPositive && ob.Outcome != VoidConfirmed {
		want := op.Requested
		if ob.Amount == nil || *ob.Amount != want || ob.Currency != i.Currency {
			return conflict(d, "EVIDENCE_AMOUNT_OR_CURRENCY_MISMATCH")
		}
	}

	switch op.Kind {
	case OpConfirm:
		return observeConfirm(d, i, ob)
	case OpCapture:
		return observeCapture(d, i, op, ob)
	case OpVoid:
		return observeVoid(d, i, ob)
	}
	return keep(Quarantined, "UNKNOWN_OPERATION_KIND", CaseQuarantine)
}

func conflict(d Decision, reason string) Decision {
	d.OpResolution = ResConflicted
	d.Next.Frozen = true
	d.Disposition, d.Reason, d.Case = Conflict, reason, CaseConflict
	d.step("EVIDENCE_CONFLICT", d.Next.Status)
	if d.Next.Active != nil {
		a := *d.Next.Active
		a.Resolution = ResConflicted
		d.Next.Active = &a
	}
	return d
}

func resolve(d *Decision, r Resolution) {
	d.OpResolution = r
	if !r.Unresolved() {
		d.Next.Active = nil
	} else if d.Next.Active != nil {
		a := *d.Next.Active
		a.Resolution = r
		d.Next.Active = &a
	}
}

func unknown(d Decision, i Intent, in Input) Decision {
	if i.Active.Resolution == ResUnknown {
		d.Disposition, d.Reason = Recorded, "ALREADY_UNKNOWN"
		return d
	}
	resolve(&d, ResUnknown)
	d.AttemptStatus = AttemptUnknown
	d.Emits = []Emit{EmitOutcomeUnknown}
	d.step(in, d.Next.Status)
	d.Disposition, d.Reason = Applied, "OUTCOME_UNKNOWN_INQUIRY_REQUIRED"
	return d
}

func pending(d Decision, i Intent) Decision {
	resolve(&d, ResPending)
	d.AttemptStatus = AttemptPending
	d.step(Input(ProviderPending), i.Status)
	d.Disposition = Applied
	return d
}

func observeConfirm(d Decision, i Intent, ob Observation) Decision {
	in := Input(ob.Outcome)
	switch ob.Outcome {
	case ProviderChallenge:
		if i.Status != Processing {
			d.Disposition, d.Reason = Recorded, "CHALLENGE_ALREADY_ACTIVE"
			return d
		}
		d.SetAction, d.AttemptStatus = true, AttemptActionRequired
		d.step(in, RequiresCustomerAction)
	case CustomerActionComplete:
		if i.Status != RequiresCustomerAction {
			d.Disposition, d.Reason = Recorded, "NO_ACTION_OUTSTANDING"
			return d
		}
		d.ClearAction = true
		d.step(in, Processing)
	case CustomerActionExpired:
		if i.Status != RequiresCustomerAction {
			d.Disposition, d.Reason = Recorded, "NO_ACTION_OUTSTANDING"
			return d
		}
		// Inquire before terminal failure: the send may have occurred.
		d.ClearAction = true
		d.Next.Status = Processing
		d.Steps = append(d.Steps, Step{Input: in, From: RequiresCustomerAction, To: Processing})
		d.Next.Version++
		if i.Active.Resolution != ResUnknown {
			resolve(&d, ResUnknown)
			d.AttemptStatus = AttemptUnknown
			d.Emits = []Emit{EmitOutcomeUnknown}
		}
	case ProviderAuthorized:
		if i.Status != Processing {
			d.Disposition, d.Reason, d.Case = Recorded, "AUTHORIZATION_WHILE_AWAITING_CUSTOMER_ACTION", CaseQuarantine
			return d
		}
		if i.CaptureMethod == Automatic {
			// An authorization is not the completed automatic-capture effect.
			d.AttemptStatus = AttemptAuthorized
			d.Disposition, d.Reason = Recorded, "AUTHORIZED_AWAITING_EXECUTION"
			return d
		}
		resolve(&d, ResPositive)
		d.AttemptStatus = AttemptAuthorized
		d.Next.Authorized = i.Requested
		d.AuthorizeAmount = i.Requested
		d.Emits = []Emit{EmitAuthorizationConfirmed}
		d.step(in, RequiresCapture)
		if i.CancelRequested {
			// Cancel was requested while in flight: queue the verified void (§5.1).
			d.step(InVoidAuthRequest, RequiresCapture)
			d.NewOp = &NewOperation{Kind: OpVoid, Requested: i.Requested}
			d.Emits = append(d.Emits, EmitAttemptRequested)
			d.Reason = "VOID_QUEUED_AFTER_CANCEL_REQUEST"
		}
	case ProviderExecutionSuccess:
		if i.Status != Processing {
			d.Disposition, d.Reason, d.Case = Recorded, "EXECUTION_WHILE_AWAITING_CUSTOMER_ACTION", CaseQuarantine
			return d
		}
		if i.CaptureMethod != Automatic {
			return conflict(d, "EXECUTION_ON_MANUAL_CAPTURE_INTENT")
		}
		resolve(&d, ResPositive)
		d.AttemptStatus = AttemptSucceeded
		d.Next.Authorized, d.Next.Captured = i.Requested, i.Requested
		d.CaptureAmount = i.Requested
		d.Emits = []Emit{EmitCaptureConfirmed}
		d.step(in, Succeeded)
		if i.CancelRequested {
			d.Reason = "CANCEL_REJECTED_PAYMENT_EXECUTED"
		}
	case ProviderDeclinedRetryable, ProviderDeclinedFinal, ProviderNoEffectProven:
		resolve(&d, ResNegative)
		d.AttemptStatus = AttemptDeclined
		if ob.Outcome == ProviderNoEffectProven {
			d.AttemptStatus = AttemptNoEffect
		}
		retry := ob.Outcome == ProviderDeclinedRetryable || (ob.Outcome == ProviderNoEffectProven && ob.RetryEligible)
		switch {
		case i.CancelRequested:
			d.step(in, Canceled) // CANCEL_NO_EFFECT_PROVEN
			d.Reason = "CANCELED_NO_EFFECT_PROVEN"
		case retry:
			d.ClearToken, d.Next.HasToken = true, false
			d.step(in, RequiresPaymentMethod)
			d.Reason = "DECLINED_RETRY_WITH_NEW_METHOD"
		default:
			d.step(in, Failed)
			d.Reason = "DECLINED_FINAL"
		}
		d.Next.Active = nil
	case ProviderPending:
		return pending(d, i)
	case ProviderOutcomeUnknown:
		return unknown(d, i, in)
	}
	if d.Disposition == "" {
		d.Disposition = Applied
	}
	return d
}

func observeCapture(d Decision, i Intent, op Operation, ob Observation) Decision {
	in := Input(ob.Outcome)
	switch ob.Outcome {
	case CaptureConfirmedFinal:
		resolve(&d, ResPositive)
		d.AttemptStatus = AttemptSucceeded
		d.Next.Captured = i.Captured + op.Requested
		d.Next.Reserved = i.Reserved - op.Requested
		d.CaptureAmount = op.Requested
		d.Emits = []Emit{EmitCaptureConfirmed}
		d.step(in, Succeeded)
	case CaptureFailedNoEffect:
		resolve(&d, ResNegative)
		d.AttemptStatus = AttemptNoEffect
		d.Next.Reserved = i.Reserved - op.Requested
		d.step(in, RequiresCapture)
	case CaptureUnknown, ProviderOutcomeUnknown:
		return unknown(d, i, Input(CaptureUnknown))
	case ProviderPending:
		return pending(d, i)
	}
	d.Disposition = Applied
	return d
}

func observeVoid(d Decision, i Intent, ob Observation) Decision {
	in := Input(ob.Outcome)
	switch ob.Outcome {
	case VoidConfirmed:
		if i.Captured != 0 {
			return conflict(d, "VOID_AFTER_CAPTURE")
		}
		resolve(&d, ResPositive)
		d.AttemptStatus = AttemptSucceeded
		d.step(in, Canceled)
		d.Reason = "VOID_CONFIRMED"
	case ProviderNoEffectProven:
		// The void did nothing; the authorization is still live.
		resolve(&d, ResNegative)
		d.AttemptStatus = AttemptNoEffect
		d.Next.CancelRequested = false
		d.step(in, RequiresCapture)
		d.Reason = "VOID_NO_EFFECT"
	case ProviderOutcomeUnknown:
		return unknown(d, i, in)
	case ProviderPending:
		return pending(d, i)
	}
	d.Disposition = Applied
	return d
}
