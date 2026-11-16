package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/payment/domain"
	"github.com/zoiko/zoikopay/internal/payment/events"
	"github.com/zoiko/zoikopay/internal/payment/store"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/inbox"
	"github.com/zoiko/zoikopay/internal/platform/outbox"
)

// Consumer is the inbox consumer id of the BC-03 reducer.
const Consumer = "payment.reducer"

// ErrUnsupportedEvent marks an event this consumer must not guess about
// (unknown type or schema major, missing scope). The relay parks it after its
// attempts; nothing changes (06-01 PI-AT-049, PI-AT-052).
var ErrUnsupportedEvent = errors.New("unsupported or malformed event")

var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// HandleEvent consumes one delivered envelope from BC-04. It is idempotent:
// the inbox runs it at most once per event id, and observation ids are
// deduplicated again so a redelivered webhook under a new event id is still
// one observation (PI-AT-029).
func (s *Service) HandleEvent(ctx context.Context, envelope []byte) error {
	var e outbox.Event
	if err := json.Unmarshal(envelope, &e); err != nil {
		return fmt.Errorf("%w: %w", ErrUnsupportedEvent, err)
	}
	if err := e.Validate(); err != nil {
		return fmt.Errorf("%w: %w", ErrUnsupportedEvent, err)
	}
	switch e.Type {
	case events.TypeOutcomeObserved:
		var data events.OutcomeObserved
		if err := strictJSON(e.Data, &data); err != nil {
			return fmt.Errorf("%w: %w", ErrUnsupportedEvent, err)
		}
		return s.consume(ctx, e, data.Environment, func(ctx context.Context, tx pgx.Tx) error {
			return s.observe(ctx, tx, e, data)
		})
	case events.TypeAttemptDispatched:
		var data events.AttemptDispatched
		if err := strictJSON(e.Data, &data); err != nil {
			return fmt.Errorf("%w: %w", ErrUnsupportedEvent, err)
		}
		return s.consume(ctx, e, data.Environment, func(ctx context.Context, tx pgx.Tx) error {
			return s.dispatched(ctx, tx, e, data)
		})
	}
	return fmt.Errorf("%w: type %s", ErrUnsupportedEvent, e.Type)
}

func strictJSON(b []byte, v any) error {
	dec := json.NewDecoder(bytesReader(b))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func (s *Service) consume(ctx context.Context, e outbox.Event, env string, fn func(context.Context, pgx.Tx) error) error {
	t := db.Tenant{Environment: env, CellID: e.CellID, LegalEntityID: e.LegalEntityID, TenantID: e.TenantID}
	in := inbox.Inbox{Schema: Schema, Now: s.Now}
	err := db.InTenantTx(ctx, s.Pool, t, func(tx pgx.Tx) error {
		_, err := in.Process(ctx, tx, Consumer, e.ID, e.Type, fn)
		return err
	})
	if errors.Is(err, db.ErrNoTenant) {
		return fmt.Errorf("%w: %w", ErrUnsupportedEvent, err)
	}
	return err
}

// observe applies provider.outcome.observed.v1 (06-01 §7.1 step 5).
func (s *Service) observe(ctx context.Context, tx pgx.Tx, e outbox.Event, o events.OutcomeObserved) error {
	q := store.New(tx)
	now := s.now()
	record := func(opID *string, disp domain.Disposition, reason string) (bool, error) {
		var amt *int64
		if o.Amount != nil {
			amt = ptr(int64(*o.Amount))
		}
		var cur, acct, ref *string
		if o.Currency != "" {
			cur = &o.Currency
		}
		if o.ProviderAccountID != "" {
			acct = &o.ProviderAccountID
		}
		if o.ProviderReference != "" {
			ref = &o.ProviderReference
		}
		digest := o.EvidenceDigest
		if !digestPattern.MatchString(digest) {
			sum := sha256.Sum256(e.Data)
			digest, disp, reason = hex.EncodeToString(sum[:]), domain.Quarantined, "MISSING_EVIDENCE_DIGEST"
		}
		n, err := q.InsertObservation(ctx, store.InsertObservationParams{ObservationID: o.ObservationID, TenantID: e.TenantID,
			EventID: e.ID, OperationID: opID, OperationPublicID: o.OperationID, Outcome: o.Outcome, SourceChannel: o.SourceChannel,
			ProviderAccountID: acct, ProviderReference: ref, AmountMinor: amt, Currency: cur, EvidenceDigest: digest,
			ObservedAtUtc: o.ObservedAt.UTC(), RecordedAtUtc: now, Disposition: string(disp), DispositionReason: &reason})
		if err != nil {
			return false, fmt.Errorf("record observation: %w", err)
		}
		return n == 1, nil
	}
	switch o.SourceChannel {
	case "SYNC_RESPONSE", "WEBHOOK", "INQUIRY":
	default:
		return fmt.Errorf("%w: source_channel %q", ErrUnsupportedEvent, o.SourceChannel)
	}
	if o.ObservationID == "" || o.OperationID == "" {
		return fmt.Errorf("%w: observation_id and operation_id are required", ErrUnsupportedEvent)
	}

	op, err := q.FindOperationByPublicID(ctx, o.OperationID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Orphan observation: kept as evidence, nothing to reduce (06-01 §1.1 "orphan provider events").
		if _, err := record(nil, domain.Quarantined, "UNKNOWN_OPERATION"); err != nil {
			return err
		}
		s.log().Warn("orphan provider observation", "operation", o.OperationID, "observation", o.ObservationID)
		return nil
	}
	if err != nil {
		return fmt.Errorf("find operation: %w", err)
	}
	row, err := q.LockIntentByID(ctx, op.IntentID)
	if err != nil {
		return fmt.Errorf("lock intent: %w", err)
	}
	l, err := load(ctx, q, row)
	if err != nil {
		return err
	}
	attempt, err := q.GetAttemptByOperation(ctx, op.OperationID)
	if err != nil {
		return fmt.Errorf("load attempt: %w", err)
	}

	// The observation must come from the provider account the attempt was
	// dispatched to (06-01 PI-AT-032).
	var dec domain.Decision
	switch {
	case attempt.ProviderAccountID != nil && o.ProviderAccountID != *attempt.ProviderAccountID:
		dec = domain.Decision{Next: l.domain(), Disposition: domain.Quarantined, Reason: "PROVIDER_ACCOUNT_MISMATCH", Case: domain.CaseQuarantine}
	default:
		if attempt.ProviderAccountID == nil && o.ProviderAccountID != "" {
			attempt.ProviderAccountID = &o.ProviderAccountID
		}
		var amt *int64
		if o.Amount != nil {
			amt = ptr(int64(*o.Amount))
		}
		dec = domain.Observe(l.domain(), domain.Operation{ID: op.PublicID, Kind: domain.OpKind(op.Kind),
			Resolution: domain.Resolution(op.Resolution), Requested: op.RequestedMinor},
			domain.Observation{Outcome: domain.Outcome(o.Outcome), Amount: amt, Currency: o.Currency,
				RetryEligible: o.RetryEligible, HasAction: o.ActionRef != ""})
	}

	fresh, err := record(&op.OperationID, dec.Disposition, dec.Reason)
	if err != nil {
		return err
	}
	if !fresh {
		return nil // same observation already recorded and reduced
	}
	meta := applyMeta{actor: "provider:" + o.SourceChannel, correlationID: e.CorrelationID, observedOp: &op,
		observationID: &o.ObservationID, causationID: e.ID, attempt: &attempt}
	if o.ActionRef != "" {
		meta.actionRef, meta.actionExpires = &o.ActionRef, o.ActionExpiresAt
	}
	if dec.Disposition != domain.Applied && dec.Disposition != domain.Conflict {
		// Evidence only; keep the attempt's first provider account, open a case if asked.
		dec.Steps = nil
	}
	_, err = s.apply(ctx, tx, l, dec, meta)
	return err
}

// dispatched applies payment.attempt.dispatched.v1: BC-04 sent the
// instruction under the stored identity (06-01 §7.1 step 3).
func (s *Service) dispatched(ctx context.Context, tx pgx.Tx, e outbox.Event, d events.AttemptDispatched) error {
	q := store.New(tx)
	op, err := q.FindOperationByPublicID(ctx, d.OperationID)
	if err != nil {
		return fmt.Errorf("%w: unknown operation %s", ErrUnsupportedEvent, d.OperationID)
	}
	at, err := q.GetAttemptByOperation(ctx, op.OperationID)
	if err != nil {
		return fmt.Errorf("load attempt: %w", err)
	}
	sum := sha256.Sum256(e.Data)
	disp, reason := domain.Applied, "DISPATCHED"
	switch {
	case d.AttemptID != at.AttemptID || d.ProviderInstructionKey != at.ProviderInstructionKey:
		// A fresh provider key is forbidden (06-01 §7.3 R0).
		disp, reason = domain.Quarantined, "INSTRUCTION_IDENTITY_MISMATCH"
	case at.ProviderAccountID != nil && *at.ProviderAccountID != d.ProviderAccountID:
		disp, reason = domain.Quarantined, "PROVIDER_ACCOUNT_MISMATCH"
	}
	acct := d.ProviderAccountID
	if _, err := q.InsertObservation(ctx, store.InsertObservationParams{ObservationID: e.ID, TenantID: e.TenantID, EventID: e.ID,
		OperationID: &op.OperationID, OperationPublicID: op.PublicID, Outcome: "DISPATCHED", SourceChannel: "DISPATCH",
		ProviderAccountID: &acct, EvidenceDigest: hex.EncodeToString(sum[:]), ObservedAtUtc: d.DispatchedAt.UTC(),
		RecordedAtUtc: s.now(), Disposition: string(disp), DispositionReason: &reason}); err != nil {
		return fmt.Errorf("record dispatch: %w", err)
	}
	if disp != domain.Applied {
		row, err := q.LockIntentByID(ctx, op.IntentID)
		if err != nil {
			return err
		}
		return s.openCase(ctx, q, row, &op, domain.Decision{Case: domain.CaseQuarantine, Reason: reason})
	}
	status := at.AttemptStatus
	if status == string(domain.AttemptReserved) {
		status = string(domain.AttemptDispatching)
	}
	return q.UpdateAttempt(ctx, store.UpdateAttemptParams{ProviderAccountID: &acct, AttemptStatus: status, UpdatedAtUtc: s.now(), AttemptID: at.AttemptID})
}
