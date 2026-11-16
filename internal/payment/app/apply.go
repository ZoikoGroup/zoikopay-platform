package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/payment/domain"
	"github.com/zoiko/zoikopay/internal/payment/events"
	"github.com/zoiko/zoikopay/internal/payment/store"
	"github.com/zoiko/zoikopay/internal/platform/ids"
	"github.com/zoiko/zoikopay/internal/platform/money"
)

// errConcurrent means the compare-and-swap lost a race (PI-INV-08). It is
// never expected under the row lock taken first; it is a defensive check.
var errConcurrent = errors.New("payment intent changed concurrently")

// loaded is an intent row plus its unresolved operation.
type loaded struct {
	row    store.PaymentPaymentIntent
	active *store.PaymentPaymentOperation
}

func load(ctx context.Context, q *store.Queries, row store.PaymentPaymentIntent) (loaded, error) {
	l := loaded{row: row}
	if row.ActiveOperationID != nil {
		op, err := q.GetOperation(ctx, *row.ActiveOperationID)
		if err != nil {
			return l, fmt.Errorf("load active operation: %w", err)
		}
		l.active = &op
	}
	return l, nil
}

func (l loaded) domain() domain.Intent {
	r := l.row
	i := domain.Intent{
		Status: domain.Status(r.IntentStatus), Version: r.AggregateVersion, CaptureMethod: domain.CaptureMethod(r.CaptureMethod),
		Requested: r.AmountRequestedMinor, Currency: r.Currency, Authorized: r.AuthorizedMinor, Captured: r.CapturedMinor,
		Reserved: r.ReservedCaptureMinor, HasToken: r.PaymentMethodTokenRef != nil, CancelRequested: r.CancelRequestedAtUtc != nil,
		Frozen: r.FrozenAtUtc != nil, ExpiryFlagged: r.ExpiryFlaggedAtUtc != nil,
	}
	if r.ExpiresAtUtc != nil {
		i.ExpiresAt = *r.ExpiresAtUtc
	}
	if l.active != nil {
		i.Active = &domain.Operation{ID: l.active.PublicID, Kind: domain.OpKind(l.active.Kind),
			Resolution: domain.Resolution(l.active.Resolution), Requested: l.active.RequestedMinor}
	}
	return i
}

// applyMeta carries audit context and inputs that are not part of the domain view.
type applyMeta struct {
	actor         string
	correlationID string
	policyVersion string  // new policy version (commands); "" keeps the stored one
	token         *string // token reference when Decision.SetToken
	observedOp    *store.PaymentPaymentOperation
	observationID *string
	causationID   string
	actionRef     *string
	actionExpires *time.Time
	attempt       *store.PaymentPaymentAttempt // attempt of observedOp, when known
}

// applied reports what apply created.
type applied struct {
	intent store.PaymentPaymentIntent
	newOp  *store.PaymentPaymentOperation
}

func ptr[T any](v T) *T { return &v }

// apply persists a Decision atomically in tx (06-01 B.1: reserve or close the
// effect identity, append transition audit, update with CAS, insert outbox).
func (s *Service) apply(ctx context.Context, tx pgx.Tx, l loaded, d domain.Decision, m applyMeta) (applied, error) {
	q := store.New(tx)
	now := s.now()
	r := l.row
	out := applied{intent: r}
	if len(d.Steps) == 0 {
		// Evidence-only decisions: the aggregate does not change, but the
		// attempt may, and a recovery case may be needed.
		if d.AttemptStatus != "" && m.attempt != nil {
			if err := q.UpdateAttempt(ctx, store.UpdateAttemptParams{ProviderAccountID: m.attempt.ProviderAccountID,
				AttemptStatus: string(d.AttemptStatus), UpdatedAtUtc: now, AttemptID: m.attempt.AttemptID}); err != nil {
				return out, fmt.Errorf("update attempt: %w", err)
			}
		}
		return out, s.openCase(ctx, q, r, m.observedOp, d)
	}

	policy := r.PolicyVersion
	if m.policyVersion != "" {
		policy = m.policyVersion
	}
	activeID, latestID := r.ActiveOperationID, r.LatestOperationID

	// Resolve the observed or active operation.
	resolvedOp := m.observedOp
	if resolvedOp == nil {
		resolvedOp = l.active
	}
	if d.OpResolution != "" && resolvedOp != nil {
		var at *time.Time
		if d.OpResolution == domain.ResPositive || d.OpResolution == domain.ResNegative {
			at = &now
		}
		if err := q.UpdateOperationResolution(ctx, store.UpdateOperationResolutionParams{
			Resolution: string(d.OpResolution), ResolvedAtUtc: at, OperationID: resolvedOp.OperationID}); err != nil {
			return out, fmt.Errorf("update operation resolution: %w", err)
		}
		resolvedOp.Resolution = string(d.OpResolution)
		if !d.OpResolution.Unresolved() {
			activeID = nil
			if err := q.CompleteWork(ctx, store.CompleteWorkParams{DoneAtUtc: &now, Kind: "OPERATION_RESOLUTION", RefID: resolvedOp.OperationID}); err != nil {
				return out, fmt.Errorf("complete operation schedule: %w", err)
			}
		}
	}
	if d.AttemptStatus != "" && m.attempt != nil {
		if err := q.UpdateAttempt(ctx, store.UpdateAttemptParams{ProviderAccountID: m.attempt.ProviderAccountID,
			AttemptStatus: string(d.AttemptStatus), UpdatedAtUtc: now, AttemptID: m.attempt.AttemptID}); err != nil {
			return out, fmt.Errorf("update attempt: %w", err)
		}
	}

	// Create the new operation, its attempt and its resolution schedule.
	var newAttempt *store.PaymentPaymentAttempt
	if d.NewOp != nil {
		op := store.PaymentPaymentOperation{
			OperationID: s.IDs.NewInternal(), PublicID: s.IDs.NewPublic(ids.Operation), IntentID: r.IntentID,
			TenantID: r.TenantID, Kind: string(d.NewOp.Kind), EconomicEffectID: s.IDs.NewInternal(),
			RequestedMinor: d.NewOp.Requested, Currency: r.Currency, Resolution: string(domain.ResPending),
			PolicyVersion: policy, CreatedAtUtc: now,
		}
		if err := q.InsertOperation(ctx, store.InsertOperationParams{OperationID: op.OperationID, PublicID: op.PublicID,
			IntentID: op.IntentID, TenantID: op.TenantID, Kind: op.Kind, EconomicEffectID: op.EconomicEffectID,
			RequestedMinor: op.RequestedMinor, Currency: op.Currency, PolicyVersion: op.PolicyVersion, CreatedAtUtc: now}); err != nil {
			return out, fmt.Errorf("insert operation: %w", err)
		}
		at := store.PaymentPaymentAttempt{AttemptID: s.IDs.NewInternal(), OperationID: op.OperationID, TenantID: r.TenantID,
			ProviderInstructionKey: s.IDs.NewInternal(), AttemptStatus: string(domain.AttemptReserved)}
		if err := q.InsertAttempt(ctx, store.InsertAttemptParams{AttemptID: at.AttemptID, OperationID: at.OperationID,
			TenantID: at.TenantID, ProviderInstructionKey: at.ProviderInstructionKey, CreatedAtUtc: now}); err != nil {
			return out, fmt.Errorf("insert attempt: %w", err)
		}
		if err := q.ScheduleWork(ctx, store.ScheduleWorkParams{Kind: "OPERATION_RESOLUTION", RefID: op.OperationID,
			Environment: r.Environment, TenantID: r.TenantID, CellID: r.CellID, LegalEntityID: r.LegalEntityID, DueAtUtc: now}); err != nil {
			return out, fmt.Errorf("schedule operation: %w", err)
		}
		out.newOp, newAttempt = &op, &at
		activeID, latestID = &op.OperationID, &op.OperationID
	}

	// Intent row: CAS from the loaded version.
	n := d.Next
	token := r.PaymentMethodTokenRef
	switch {
	case d.SetToken:
		token = m.token
	case d.ClearToken:
		token = nil
	}
	cancelAt, expiryAt, frozenAt := r.CancelRequestedAtUtc, r.ExpiryFlaggedAtUtc, r.FrozenAtUtc
	if n.CancelRequested && cancelAt == nil {
		cancelAt = &now
	}
	if !n.CancelRequested {
		cancelAt = nil
	}
	if d.FlagExpiry && expiryAt == nil {
		expiryAt = &now
	}
	if n.Frozen && frozenAt == nil {
		frozenAt = &now
	}
	actionRef, actionExp := r.ActionRef, r.ActionExpiresAtUtc
	switch {
	case d.SetAction:
		actionRef, actionExp = m.actionRef, m.actionExpires
	case d.ClearAction:
		actionRef, actionExp = nil, nil
	}
	reason := r.StatusReasonCode
	if d.Reason != "" {
		reason = &d.Reason
	}
	upd := store.UpdateIntentParams{
		PaymentMethodTokenRef: token, IntentStatus: string(n.Status), StatusReasonCode: reason,
		NewVersion: n.Version, ActiveOperationID: activeID, LatestOperationID: latestID,
		AuthorizedMinor: n.Authorized, CapturedMinor: n.Captured, ReservedCaptureMinor: n.Reserved, PolicyVersion: policy,
		CancelRequestedAtUtc: cancelAt, ExpiryFlaggedAtUtc: expiryAt, FrozenAtUtc: frozenAt,
		ActionRef: actionRef, ActionExpiresAtUtc: actionExp, UpdatedAtUtc: now,
		IntentID: r.IntentID, ExpectedVersion: r.AggregateVersion,
	}
	// One CAS update per applied step keeps aggregate_version advancing by
	// exactly one per audit row; intermediate rows carry the final values
	// (the steps belong to one atomic command).
	for k := range d.Steps {
		u := upd
		u.NewVersion, u.ExpectedVersion = r.AggregateVersion+int64(k)+1, r.AggregateVersion+int64(k)
		rows, err := q.UpdateIntent(ctx, u)
		if err != nil {
			return out, fmt.Errorf("update intent: %w", err)
		}
		if rows != 1 {
			return out, errConcurrent
		}
	}

	// Transition audit: one row per step (PI-010).
	for k, st := range d.Steps {
		opID := (*string)(nil)
		if resolvedOp != nil {
			opID = &resolvedOp.OperationID
		}
		switch st.Input {
		case domain.InConfirm, domain.InCaptureRequest, domain.InVoidAuthRequest:
			if out.newOp != nil {
				opID = &out.newOp.OperationID
			}
		}
		var from *string
		if st.From != "" {
			from = ptr(string(st.From))
		}
		if err := q.InsertTransition(ctx, store.InsertTransitionParams{
			TransitionID: s.IDs.NewInternal(), IntentID: r.IntentID, TenantID: r.TenantID,
			AggregateVersion: r.AggregateVersion + int64(k) + 1, Input: string(st.Input), FromStatus: from, ToStatus: string(st.To),
			OperationID: opID, ObservationID: m.observationID, Actor: m.actor, PolicyVersion: &policy, ReasonCode: reason,
			CorrelationID: m.correlationID, RecordedAtUtc: now}); err != nil {
			return out, fmt.Errorf("insert transition: %w", err)
		}
	}

	// Outbox events, same transaction (PI-INV-07).
	sc := events.Scope{Source: source(r.CellID), TenantID: r.TenantID, MerchantID: r.MerchantID, CellID: r.CellID,
		LegalEntityID: r.LegalEntityID, CorrelationID: m.correlationID, CausationID: m.causationID, PolicyVersion: policy}
	obsID := ""
	if m.observationID != nil {
		obsID = *m.observationID
	}
	for _, e := range d.Emits {
		var typ string
		var data any
		switch e {
		case domain.EmitIntentCreated:
			typ, data = events.TypeIntentCreated, events.IntentCreated{PaymentIntentID: r.PublicID, MerchantID: r.MerchantID,
				Amount: money.Minor(r.AmountRequestedMinor), Currency: r.Currency, CaptureMethod: lower(r.CaptureMethod),
				Status: lower(string(n.Status)), CreatedAt: r.CreatedAtUtc}
		case domain.EmitAttemptRequested:
			tok := ""
			if token != nil {
				tok = *token
			}
			typ, data = events.TypeAttemptRequested, events.AttemptRequested{PaymentIntentID: r.PublicID,
				OperationID: out.newOp.PublicID, OperationKind: out.newOp.Kind, AttemptID: newAttempt.AttemptID,
				ProviderInstructionKey: newAttempt.ProviderInstructionKey, EconomicEffectID: out.newOp.EconomicEffectID,
				Amount: money.Minor(out.newOp.RequestedMinor), Currency: r.Currency, CaptureMethod: lower(r.CaptureMethod),
				PaymentMethodTokenRef: tok, Environment: r.Environment}
		case domain.EmitAuthorizationConfirmed:
			typ, data = events.TypeAuthorizationConfirmed, events.AuthorizationConfirmed{PaymentIntentID: r.PublicID,
				OperationID: resolvedOp.PublicID, EconomicEffectID: resolvedOp.EconomicEffectID,
				Amount: money.Minor(d.AuthorizeAmount), Currency: r.Currency, ObservationID: obsID}
		case domain.EmitCaptureConfirmed:
			typ, data = events.TypeCaptureConfirmed, events.CaptureConfirmed{PaymentIntentID: r.PublicID,
				OperationID: resolvedOp.PublicID, EconomicEffectID: resolvedOp.EconomicEffectID,
				Amount: money.Minor(d.CaptureAmount), Currency: r.Currency, ObservationID: obsID}
		case domain.EmitOutcomeUnknown:
			ou := events.OutcomeUnknown{PaymentIntentID: r.PublicID, OperationID: resolvedOp.PublicID,
				OperationKind: resolvedOp.Kind, Environment: r.Environment}
			if m.attempt != nil {
				ou.AttemptID, ou.ProviderInstructionKey = m.attempt.AttemptID, m.attempt.ProviderInstructionKey
				if m.attempt.ProviderAccountID != nil {
					ou.ProviderAccountID = *m.attempt.ProviderAccountID
				}
			}
			typ, data = events.TypeOutcomeUnknown, ou
		default:
			return out, fmt.Errorf("unknown emit %q", e)
		}
		ev, err := events.Envelope(s.IDs.NewEventID(), typ, r.PublicID, n.Version, now, sc, data)
		if err != nil {
			return out, err
		}
		if _, err := s.writer().Append(ctx, tx, ev); err != nil {
			return out, fmt.Errorf("append %s: %w", typ, err)
		}
	}

	resolved := resolvedOp
	if resolved == nil {
		resolved = m.observedOp
	}
	if err := s.openCase(ctx, q, r, resolved, d); err != nil {
		return out, err
	}
	if n.Status.Terminal() {
		if err := q.CompleteWork(ctx, store.CompleteWorkParams{DoneAtUtc: &now, Kind: "INTENT_EXPIRY", RefID: r.IntentID}); err != nil {
			return out, fmt.Errorf("complete expiry schedule: %w", err)
		}
	}

	fresh, err := q.LockIntentByID(ctx, r.IntentID)
	if err != nil {
		return out, fmt.Errorf("reload intent: %w", err)
	}
	out.intent = fresh
	return out, nil
}

func (s *Service) openCase(ctx context.Context, q *store.Queries, r store.PaymentPaymentIntent, op *store.PaymentPaymentOperation, d domain.Decision) error {
	if d.Case == "" {
		return nil
	}
	var opID *string
	if op != nil {
		opID = &op.OperationID
	}
	if _, err := q.OpenRecoveryCase(ctx, store.OpenRecoveryCaseParams{CaseID: s.IDs.NewInternal(), TenantID: r.TenantID,
		IntentID: r.IntentID, OperationID: opID, Reason: string(d.Case), Detail: d.Reason, OpenedAtUtc: s.now()}); err != nil {
		return fmt.Errorf("open recovery case: %w", err)
	}
	s.log().Warn("payment recovery case opened", "intent", r.PublicID, "reason", d.Case, "detail", d.Reason)
	return nil
}

// auditCreate writes the transition rows for a new intent (CREATE then
// ATTACH_TOKEN) and its payment.intent.created event.
func (s *Service) auditCreate(ctx context.Context, tx pgx.Tx, q *store.Queries, base, row store.PaymentPaymentIntent,
	d domain.Decision, sc Scope, policy string) error {
	now := s.now()
	for k, st := range d.Steps {
		var from *string
		if st.From != "" {
			from = ptr(string(st.From))
		}
		if err := q.InsertTransition(ctx, store.InsertTransitionParams{TransitionID: s.IDs.NewInternal(), IntentID: row.IntentID,
			TenantID: row.TenantID, AggregateVersion: base.AggregateVersion + int64(k) + 1, Input: string(st.Input),
			FromStatus: from, ToStatus: string(st.To), Actor: sc.PrincipalID, PolicyVersion: &policy,
			CorrelationID: sc.CorrelationID, RecordedAtUtc: now}); err != nil {
			return fmt.Errorf("insert transition: %w", err)
		}
	}
	ev, err := events.Envelope(s.IDs.NewEventID(), events.TypeIntentCreated, row.PublicID, row.AggregateVersion, now,
		events.Scope{Source: source(row.CellID), TenantID: row.TenantID, MerchantID: row.MerchantID, CellID: row.CellID,
			LegalEntityID: row.LegalEntityID, CorrelationID: sc.CorrelationID, PolicyVersion: policy},
		events.IntentCreated{PaymentIntentID: row.PublicID, MerchantID: row.MerchantID, Amount: money.Minor(row.AmountRequestedMinor),
			Currency: row.Currency, CaptureMethod: lower(row.CaptureMethod), Status: lower(row.IntentStatus), CreatedAt: row.CreatedAtUtc})
	if err != nil {
		return err
	}
	if _, err := s.writer().Append(ctx, tx, ev); err != nil {
		return fmt.Errorf("append intent created: %w", err)
	}
	return nil
}
