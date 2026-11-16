//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/payment/app"
	"github.com/zoiko/zoikopay/internal/payment/events"
	"github.com/zoiko/zoikopay/internal/platform/apierror"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/outbox"
)

// Successful automatic-capture payment, end to end (06-01 T1/T2 shape, PI-AT-001, -026).
func TestSuccessfulAutomaticPayment(t *testing.T) {
	e := setup(t)
	pi := create(t, e, A, "automatic")
	if e.outboxCount(events.TypeAttemptRequested) != 0 {
		t.Fatal("create must not request any provider effect (PI-AT-001)")
	}
	op := confirm(t, e, A, pi.ID)
	if v := e.get(A, pi.ID); v.Status != "processing" || *v.LatestOperationID != op.ID || *v.OperationResolution != "pending" {
		t.Fatalf("after confirm = %+v", v)
	}
	attemptID, instrKey := e.attempt(op.ID)
	if err := e.dispatched(op.ID, attemptID, instrKey, "psp_acct_uk_1"); err != nil {
		t.Fatal(err)
	}
	if err := e.observe(obs{opID: op.ID, outcome: "PROVIDER_EXECUTION_SUCCESS", amount: minor(1999)}); err != nil {
		t.Fatal(err)
	}
	v := e.get(A, pi.ID)
	if v.Status != "succeeded" || v.AmountCaptured != 1999 || *v.OperationResolution != "certain_positive" {
		t.Fatalf("after success = %+v", v)
	}
	// Exactly one command to BC-04 and one capture fact for BC-05.
	if e.outboxCount(events.TypeAttemptRequested) != 1 || e.outboxCount(events.TypeCaptureConfirmed) != 1 {
		t.Fatal("expected one attempt.requested and one capture.confirmed")
	}
	// Complete audit: contiguous versions, one transition per version.
	var version int64
	e.scan(`SELECT aggregate_version FROM payment.payment_intents WHERE public_id = $1`, []any{pi.ID}, &version)
	n := e.count(`SELECT count(*) FROM payment.intent_transitions t JOIN payment.payment_intents i USING (intent_id)
		WHERE i.public_id = $1 AND t.aggregate_version BETWEEN 1 AND $2`, pi.ID, version)
	if int64(n) != version || version != 4 {
		t.Fatalf("audit rows %d for version %d; want CREATE, ATTACH_TOKEN, CONFIRM, PROVIDER_EXECUTION_SUCCESS", n, version)
	}
	if e.count(`SELECT count(*) FROM payment.command_log WHERE outcome = 'ACCEPTED'`) != 2 {
		t.Fatal("create and confirm must be in the command log")
	}
}

// Manual capture flow (06-01 T1, PI-AT-025, -036 disabled partial, -033).
func TestManualAuthorizeAndCapture(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	pi := create(t, e, A, "manual")
	op := confirm(t, e, A, pi.ID)
	if err := e.observe(obs{opID: op.ID, outcome: "PROVIDER_AUTHORIZED", amount: minor(1999)}); err != nil {
		t.Fatal(err)
	}
	if v := e.get(A, pi.ID); v.Status != "requires_capture" || v.AmountAuthorized != 1999 || v.AmountCapturable != 1999 || v.AmountCaptured != 0 {
		t.Fatalf("authorized = %+v", v)
	}
	if _, err := e.svc.CaptureIntent(ctx, A, key(t), pi.ID, app.CaptureRequest{Amount: 1000}); code(err) != apierror.CapabilityNotAvailable {
		t.Fatalf("partial capture: %v", err)
	}
	if _, err := e.svc.CaptureIntent(ctx, A, key(t), pi.ID, app.CaptureRequest{Amount: 5000}); code(err) != apierror.ValidationError {
		t.Fatalf("over-capture: %v", err)
	}
	res, err := e.svc.CaptureIntent(ctx, A, key(t), pi.ID, app.CaptureRequest{Amount: 1999})
	if err != nil || res.Status != 202 || res.Op.Kind != "capture" {
		t.Fatalf("capture = %+v, %v", res, err)
	}
	if v := e.get(A, pi.ID); v.AmountCapturable != 0 {
		t.Fatalf("reservation must count against capacity: %+v", v)
	}
	if err := e.observe(obs{opID: res.Op.ID, outcome: "CAPTURE_CONFIRMED_FINAL", amount: minor(1999)}); err != nil {
		t.Fatal(err)
	}
	if v := e.get(A, pi.ID); v.Status != "succeeded" || v.AmountCaptured != 1999 {
		t.Fatalf("captured = %+v", v)
	}
	if e.outboxCount(events.TypeAuthorizationConfirmed) != 1 || e.outboxCount(events.TypeCaptureConfirmed) != 1 {
		t.Fatal("expected authorization.confirmed then capture.confirmed")
	}
}

// Declined payments: retryable then final (06-01 T4).
func TestDeclinedPayments(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	pi := create(t, e, A, "automatic")
	op := confirm(t, e, A, pi.ID)
	if err := e.observe(obs{opID: op.ID, outcome: "PROVIDER_DECLINED_RETRYABLE"}); err != nil {
		t.Fatal(err)
	}
	if v := e.get(A, pi.ID); v.Status != "requires_payment_method" {
		t.Fatalf("retryable decline = %+v", v)
	}
	if _, err := e.svc.ConfirmIntent(ctx, A, key(t), pi.ID, app.ConfirmRequest{}); code(err) != apierror.OperationStateConflict {
		t.Fatalf("confirm without a new method: %v", err)
	}
	tok := "tok_mastercard_2"
	res, err := e.svc.ConfirmIntent(ctx, A, key(t), pi.ID, app.ConfirmRequest{PaymentMethodToken: &tok})
	if err != nil || res.Op.ID == op.ID {
		t.Fatalf("retry with new method = %+v, %v", res, err)
	}
	if err := e.observe(obs{opID: res.Op.ID, outcome: "PROVIDER_DECLINED_FINAL"}); err != nil {
		t.Fatal(err)
	}
	if v := e.get(A, pi.ID); v.Status != "failed" {
		t.Fatalf("final decline = %+v", v)
	}
	// The earlier attempt is preserved, not overwritten.
	if e.count(`SELECT count(*) FROM payment.payment_operations WHERE resolution = 'CERTAIN_NEGATIVE'`) != 2 {
		t.Fatal("both declined operations must be kept")
	}
	if _, err := e.svc.ConfirmIntent(ctx, A, key(t), pi.ID, app.ConfirmRequest{PaymentMethodToken: &tok}); code(err) != apierror.OperationStateConflict {
		t.Fatalf("failed intent revived: %v (PI-AT-012)", err)
	}
}

// Timeout: unknown outcome, same-key retry, inquiry-first recovery (06-01 T3,
// PI-AT-022, -027, -028; 02-07).
func TestTimeoutUnknownThenInquiryRecovers(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	pi := create(t, e, A, "automatic")
	k := key(t)
	first, err := e.svc.ConfirmIntent(ctx, A, k, pi.ID, app.ConfirmRequest{})
	if err != nil {
		t.Fatal(err)
	}
	attemptID, instrKey := e.attempt(first.Op.ID)
	if err := e.observe(obs{opID: first.Op.ID, outcome: "PROVIDER_OUTCOME_UNKNOWN", channel: "SYNC_RESPONSE"}); err != nil {
		t.Fatal(err)
	}
	v := e.get(A, pi.ID)
	if v.Status != "processing" || *v.OperationResolution != "unknown" {
		t.Fatalf("unknown must stay processing, never failed: %+v", v)
	}
	if e.outboxCount(events.TypeOutcomeUnknown) != 1 {
		t.Fatal("payment.outcome.unknown must be emitted for BC-04 inquiry")
	}
	// The client times out and retries with the SAME key: same operation.
	again, err := e.svc.ConfirmIntent(ctx, A, k, pi.ID, app.ConfirmRequest{})
	if err != nil || !again.Replayed || again.Op.ID != first.Op.ID || again.Op.Resolution != "unknown" {
		t.Fatalf("same-key retry = %+v, %v", again, err)
	}
	// A NEW key cannot start a second effect while unknown (PI-INV-05).
	if _, err := e.svc.ConfirmIntent(ctx, A, key(t), pi.ID, app.ConfirmRequest{}); code(err) != apierror.OperationInProgress && code(err) != apierror.OperationStateConflict {
		t.Fatalf("new-key confirm during unknown: %v", err)
	}
	// Inquiry proves success under the original identity.
	if err := e.observe(obs{opID: first.Op.ID, outcome: "PROVIDER_EXECUTION_SUCCESS", amount: minor(1999), channel: "INQUIRY"}); err != nil {
		t.Fatal(err)
	}
	if v := e.get(A, pi.ID); v.Status != "succeeded" {
		t.Fatalf("after inquiry = %+v", v)
	}
	// One attempt, one provider instruction key, ever.
	a2, k2 := e.attempt(first.Op.ID)
	if a2 != attemptID || k2 != instrKey || e.count(`SELECT count(*) FROM payment.payment_attempts`) != 1 ||
		e.outboxCount(events.TypeAttemptRequested) != 1 {
		t.Fatal("recovery must never create a second attempt or provider key")
	}
}

// Duplicate requests (PI-AT-017, -018; 04-08).
func TestDuplicateRequests(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	k := key(t)
	req := app.CreateRequest{Amount: 500, Currency: "GBP", CaptureMethod: "automatic", PaymentMethodToken: "tok_visa_1"}
	r1, err := e.svc.CreateIntent(ctx, A, k, req)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := e.svc.CreateIntent(ctx, A, k, req)
	if err != nil || !r2.Replayed || r2.Intent.ID != r1.Intent.ID || r2.Status != 201 {
		t.Fatalf("replay = %+v, %v", r2, err)
	}
	changed := req
	changed.Amount = 501
	if _, err := e.svc.CreateIntent(ctx, A, k, changed); code(err) != apierror.IdempotencyFingerprintMismatch {
		t.Fatalf("changed body: %v", err)
	}
	if n := e.count(`SELECT count(*) FROM payment.payment_intents`); n != 1 {
		t.Fatalf("intents = %d; want 1", n)
	}
	if e.outboxCount(events.TypeIntentCreated) != 1 {
		t.Fatal("one intent.created only")
	}
	if e.count(`SELECT count(*) FROM payment.command_log WHERE outcome = 'REPLAYED'`) != 1 ||
		e.count(`SELECT count(*) FROM payment.command_log WHERE outcome = 'REFUSED' AND problem_code = 'idempotency_fingerprint_mismatch'`) != 1 {
		t.Fatal("replay and mismatch must be audited")
	}
}

// Concurrent requests (PI-AT-017, -019, -020; 06-01 §9.2).
func TestConcurrentRequests(t *testing.T) {
	ctx := context.Background()
	e := setup(t)

	t.Run("25 clients, same key: one operation", func(t *testing.T) {
		pi := create(t, e, A, "automatic")
		k := key(t)
		var wg sync.WaitGroup
		ops := make(chan string, 25)
		for range 25 {
			wg.Go(func() {
				r, err := e.svc.ConfirmIntent(ctx, A, k, pi.ID, app.ConfirmRequest{})
				if err != nil {
					t.Error(err)
					return
				}
				ops <- r.Op.ID
			})
		}
		wg.Wait()
		close(ops)
		seen := map[string]bool{}
		for id := range ops {
			seen[id] = true
		}
		if len(seen) != 1 || e.count(`SELECT count(*) FROM payment.payment_operations o JOIN payment.payment_intents i USING (intent_id) WHERE i.public_id = $1`, pi.ID) != 1 {
			t.Fatalf("operations = %v", seen)
		}
	})

	t.Run("10 clients, different keys: exactly one accepted", func(t *testing.T) {
		pi := create(t, e, A, "automatic")
		var wg sync.WaitGroup
		var mu sync.Mutex
		accepted := 0
		for range 10 {
			wg.Go(func() {
				_, err := e.svc.ConfirmIntent(ctx, A, key(t), pi.ID, app.ConfirmRequest{})
				mu.Lock()
				defer mu.Unlock()
				switch code(err) {
				case "":
					accepted++
				case apierror.OperationInProgress, apierror.OperationStateConflict:
				default:
					t.Errorf("unexpected: %v", err)
				}
			})
		}
		wg.Wait()
		if accepted != 1 {
			t.Fatalf("accepted = %d; want 1", accepted)
		}
	})

	t.Run("confirm vs cancel race: one winner, consistent loser", func(t *testing.T) {
		for range 5 {
			pi := create(t, e, A, "automatic")
			var wg sync.WaitGroup
			var cErr, xErr error
			var xRes app.Result
			wg.Go(func() { _, cErr = e.svc.ConfirmIntent(ctx, A, key(t), pi.ID, app.ConfirmRequest{}) })
			wg.Go(func() { xRes, xErr = e.svc.CancelIntent(ctx, A, key(t), pi.ID, app.CancelRequest{}) })
			wg.Wait()
			v := e.get(A, pi.ID)
			switch {
			case cErr == nil && xErr == nil:
				// Confirm won; cancel became a request on the in-flight payment.
				if v.Status != "processing" || !v.CancellationRequested {
					t.Fatalf("both accepted but state %+v", v)
				}
			case cErr != nil && xErr == nil:
				if v.Status != "canceled" || xRes.Status != 200 {
					t.Fatalf("cancel won but state %+v", v)
				}
			default:
				t.Fatalf("confirm=%v cancel=%v", cErr, xErr)
			}
		}
	})
}

// Process crash during a command: nothing partial survives (PI-AT-066 shape).
func TestCrashDuringConfirmLeavesNoEffect(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	pi := create(t, e, A, "automatic")
	// Kill every zp_execution backend while confirms are in flight.
	stop := make(chan struct{})
	killed := make(chan int, 1)
	go func() {
		n := 0
		for {
			select {
			case <-stop:
				killed <- n
				return
			default:
				var k int
				_ = e.super.QueryRow(ctx, `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid)) FROM pg_stat_activity
					WHERE usename = 'zp_execution' AND state = 'idle in transaction'`).Scan(&k)
				n += k
			}
		}
	}()
	k := key(t)
	for range 20 {
		_, _ = e.svc.ConfirmIntent(ctx, A, k, pi.ID, app.ConfirmRequest{})
	}
	close(stop)
	t.Logf("chaos: terminated %d zp_execution backends mid-transaction", <-killed)
	time.Sleep(50 * time.Millisecond)
	// Whatever happened, the same key now yields one operation and the
	// database never holds a half-written command.
	r, err := e.svc.ConfirmIntent(ctx, A, k, pi.ID, app.ConfirmRequest{})
	if err != nil {
		t.Fatal(err)
	}
	ops := e.count(`SELECT count(*) FROM payment.payment_operations`)
	attempts := e.count(`SELECT count(*) FROM payment.payment_attempts`)
	requested := e.outboxCount(events.TypeAttemptRequested)
	if ops != 1 || attempts != 1 || requested != 1 {
		t.Fatalf("ops=%d attempts=%d requested=%d; want exactly one each (op %s)", ops, attempts, requested, r.Op.ID)
	}
}

// Crash after commit, before BC-04 consumed: the relay redelivers the same
// instruction identity, never a fresh one (PI-AT-021, -065).
func TestRelayRedeliversSameInstructionIdentity(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	pi := create(t, e, A, "automatic")
	op := confirm(t, e, A, pi.ID)
	_, wantKey := e.attempt(op.ID)

	var got []events.AttemptRequested
	pub := publisher(func(_ context.Context, m outbox.Message) error {
		if m.Type != events.TypeAttemptRequested {
			return nil
		}
		var env outbox.Event
		_ = json.Unmarshal(m.Envelope, &env)
		var d events.AttemptRequested
		_ = json.Unmarshal(env.Data, &d)
		got = append(got, d)
		if len(got) == 1 {
			panic("execution process killed after BC-04 received the command")
		}
		return nil
	})
	relay := outbox.Relay{Pool: e.relay, Schema: app.Schema, Publisher: pub, Now: e.clk.Now}
	// Run the relay repeatedly; one pass "crashes" mid-delivery.
	for range 5 {
		func() {
			defer func() { _ = recover() }()
			_, _ = relay.RunOnce(ctx)
		}()
	}
	if len(got) != 2 || got[0].ProviderInstructionKey != wantKey || got[1].ProviderInstructionKey != wantKey || got[0].OperationID != op.ID {
		t.Fatalf("deliveries = %+v; want the same instruction key %s twice", got, wantKey)
	}
}

type publisher func(context.Context, outbox.Message) error

func (p publisher) Publish(ctx context.Context, m outbox.Message) error { return p(ctx, m) }

// Duplicate, late and conflicting provider evidence (PI-AT-024, -029, -031, -032; T8).
func TestProviderEvidenceRules(t *testing.T) {
	e := setup(t)
	pi := create(t, e, A, "automatic")
	op := confirm(t, e, A, pi.ID)
	attemptID, k := e.attempt(op.ID)
	if err := e.dispatched(op.ID, attemptID, k, "psp_acct_uk_1"); err != nil {
		t.Fatal(err)
	}

	// Wrong provider account: quarantined, no transition, case opened.
	if err := e.observe(obs{opID: op.ID, outcome: "PROVIDER_EXECUTION_SUCCESS", amount: minor(1999), account: "psp_acct_other"}); err != nil {
		t.Fatal(err)
	}
	if v := e.get(A, pi.ID); v.Status != "processing" {
		t.Fatalf("wrong-account evidence moved the intent: %+v", v)
	}
	if e.count(`SELECT count(*) FROM payment.recovery_cases WHERE reason = 'QUARANTINED_OBSERVATION'`) != 1 {
		t.Fatal("quarantine must open a case")
	}

	// The same signed webhook delivered 50 times (new event id each time): one effect.
	obsID := "0196f3a0-0000-7000-8000-000000000050"
	for range 50 {
		if err := e.observe(obs{opID: op.ID, outcome: "PROVIDER_EXECUTION_SUCCESS", amount: minor(1999), observationID: obsID}); err != nil {
			t.Fatal(err)
		}
	}
	if e.count(`SELECT count(*) FROM payment.provider_observations WHERE observation_id = $1`, obsID) != 1 ||
		e.outboxCount(events.TypeCaptureConfirmed) != 1 {
		t.Fatal("50 deliveries must be one observation and one capture fact")
	}
	if v := e.get(A, pi.ID); v.Status != "succeeded" {
		t.Fatalf("status = %s", v.Status)
	}

	// A late duplicate of the same fact: recorded, nothing changes.
	if err := e.observe(obs{opID: op.ID, outcome: "PROVIDER_EXECUTION_SUCCESS", amount: minor(1999)}); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM payment.provider_observations WHERE disposition = 'DUPLICATE'`) != 1 {
		t.Fatal("late duplicate must be recorded as DUPLICATE")
	}

	// A contradiction after success: frozen and escalated; never FAILED.
	if err := e.observe(obs{opID: op.ID, outcome: "PROVIDER_DECLINED_FINAL", channel: "INQUIRY"}); err != nil {
		t.Fatal(err)
	}
	if v := e.get(A, pi.ID); v.Status != "succeeded" || *v.OperationResolution != "conflicted" {
		t.Fatalf("contradiction = %+v", v)
	}
	if e.count(`SELECT count(*) FROM payment.recovery_cases WHERE reason = 'CONFLICTING_EVIDENCE'`) != 1 {
		t.Fatal("conflict must open a case")
	}

	// Malformed or unknown events are refused for parking, never guessed (PI-AT-049, -052).
	if err := e.deliver("com.zoiko.pay.provider.outcome.observed.v2", "ten_a", op.ID, map[string]any{}); err == nil {
		t.Fatal("unknown major version accepted")
	}
	if err := e.deliver(events.TypeOutcomeObserved, "", op.ID, map[string]any{}); err == nil {
		t.Fatal("event without tenant accepted")
	}
}

// Tenant isolation through the service (PI-AT-004, -005).
func TestTenantAndMerchantIsolation(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	pi := create(t, e, A, "automatic")
	for name, sc := range map[string]app.Scope{
		"other tenant":   scope("ten_b", "mer_a"),
		"other merchant": scope("ten_a", "mer_b"),
		"other env":      func() app.Scope { s := A; s.Environment = "LIVE"; return s }(),
	} {
		if _, err := e.svc.GetIntent(ctx, sc, pi.ID); code(err) != apierror.ResourceNotFound {
			t.Errorf("%s read: %v", name, err)
		}
		if _, err := e.svc.ConfirmIntent(ctx, sc, key(t), pi.ID, app.ConfirmRequest{}); code(err) != apierror.ResourceNotFound {
			t.Errorf("%s confirm: %v", name, err)
		}
	}
	page, err := e.svc.ListIntents(ctx, scope("ten_a", "mer_b"), "", 10)
	if err != nil || len(page.Data) != 0 {
		t.Fatalf("other merchant list = %+v, %v", page, err)
	}
	// An observation claiming another tenant cannot touch tenant A's operation.
	op := confirm(t, e, A, pi.ID)
	if err := e.observe(obs{opID: op.ID, outcome: "PROVIDER_EXECUTION_SUCCESS", amount: minor(1999), tenant: "ten_b"}); err != nil {
		t.Fatal(err)
	}
	if v := e.get(A, pi.ID); v.Status != "processing" {
		t.Fatalf("cross-tenant observation moved the intent: %+v", v)
	}
}

// Fail closed on eligibility and vault; reject PAN-like data (PI-AT-006, -008, -061).
func TestFailClosedAndPrivacy(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	req := app.CreateRequest{Amount: 1999, Currency: "GBP", CaptureMethod: "automatic", PaymentMethodToken: "tok_visa_1"}

	e.pol.deny = true
	if _, err := e.svc.CreateIntent(ctx, A, key(t), req); code(err) != apierror.CapabilityNotAvailable {
		t.Fatalf("denied: %v", err)
	}
	e.pol.deny, e.pol.down = false, true
	if _, err := e.svc.CreateIntent(ctx, A, key(t), req); code(err) != apierror.TemporarilyUnavailable {
		t.Fatalf("policy down: %v", err)
	}
	e.pol.down = false
	pi := create(t, e, A, "automatic")
	e.pol.deny = true // merchant suspended after creation (PI-AT-061)
	if _, err := e.svc.ConfirmIntent(ctx, A, key(t), pi.ID, app.ConfirmRequest{}); code(err) != apierror.CapabilityNotAvailable {
		t.Fatalf("confirm after suspension: %v", err)
	}
	e.pol.deny = false

	bad := req
	bad.PaymentMethodToken = "tok_bad"
	if _, err := e.svc.CreateIntent(ctx, A, key(t), bad); code(err) != apierror.ValidationError {
		t.Fatalf("rejected token: %v", err)
	}
	pan := "order 4111 1111 1111 1111"
	withPAN := req
	withPAN.MerchantReference = &pan
	if _, err := e.svc.CreateIntent(ctx, A, key(t), withPAN); code(err) != apierror.ValidationError {
		t.Fatalf("PAN in merchant_reference: %v", err)
	}
	for _, c := range []string{"JPY", "gbp", "XXX"} {
		r := req
		r.Currency = c
		if _, err := e.svc.CreateIntent(ctx, A, key(t), r); code(err) != apierror.ValidationError {
			t.Errorf("currency %s: %v (PI-AT-003)", c, err)
		}
	}
	huge := req
	huge.Amount = 1_000_000_000_000_000
	if _, err := e.svc.CreateIntent(ctx, A, key(t), huge); code(err) != apierror.ValidationError {
		t.Fatalf("amount over the provisional limit: %v", err)
	}
	if n := e.count(`SELECT count(*) FROM payment.payment_intents`); n != 1 {
		t.Fatalf("refused commands created intents: %d", n)
	}
	if e.count(`SELECT count(*) FROM payment.command_log WHERE outcome = 'REFUSED'`) < 9 {
		t.Fatal("every refusal must be audited")
	}
}

// Recovery: stale unresolved operations are escalated, never forced (PI-046, PI-AT-067).
func TestRecoveryEscalation(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	pi := create(t, e, A, "automatic")
	op := confirm(t, e, A, pi.ID)
	if err := e.observe(obs{opID: op.ID, outcome: "PROVIDER_OUTCOME_UNKNOWN"}); err != nil {
		t.Fatal(err)
	}
	done := create(t, e, A, "automatic")
	dop := confirm(t, e, A, done.ID)
	if err := e.observe(obs{opID: dop.ID, outcome: "PROVIDER_EXECUTION_SUCCESS", amount: minor(1999)}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.EscalateUnresolved(ctx, 0, 10); err == nil {
		t.Fatal("an unconfigured horizon must be refused")
	}
	if st, err := e.svc.EscalateUnresolved(ctx, time.Hour, 10); err != nil || st.Cases != 0 {
		t.Fatalf("too early: %+v, %v", st, err)
	}
	e.clk.Advance(2 * time.Hour)
	st, err := e.svc.EscalateUnresolved(ctx, time.Hour, 10)
	if err != nil || st.Cases != 1 {
		t.Fatalf("escalation = %+v, %v", st, err)
	}
	if v := e.get(A, pi.ID); v.Status != "processing" || *v.OperationResolution != "unknown" {
		t.Fatalf("escalation must not force an outcome: %+v", v)
	}
	if st, _ := e.svc.EscalateUnresolved(ctx, time.Hour, 10); st.Examined != 0 {
		t.Fatal("an escalated operation is not re-escalated")
	}
}

// Expiry (PI-AT-014, -015).
func TestExpirySweep(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	exp := e.clk.Now().Add(time.Hour)
	mk := func() app.IntentView {
		r, err := e.svc.CreateIntent(ctx, A, key(t), app.CreateRequest{Amount: 100, Currency: "GBP", CaptureMethod: "automatic",
			PaymentMethodToken: "tok_visa_1", ExpiresAt: &exp})
		if err != nil {
			t.Fatal(err)
		}
		return *r.Intent
	}
	idle := mk()
	busy := mk()
	confirm(t, e, A, busy.ID)
	e.clk.Advance(2 * time.Hour)
	if _, err := e.svc.ExpireDue(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if v := e.get(A, idle.ID); v.Status != "expired" {
		t.Fatalf("idle = %s", v.Status)
	}
	if v := e.get(A, busy.ID); v.Status != "processing" {
		t.Fatalf("in-flight payment must not expire blindly: %s", v.Status)
	}
	if e.count(`SELECT count(*) FROM payment.recovery_cases WHERE reason = 'EXPIRED_WITH_UNRESOLVED_EFFECT'`) != 1 {
		t.Fatal("expired-with-unresolved-effect must open a case")
	}
}

// Event reconciliation: outbox facts agree with the aggregate state.
func TestOutboxReconcilesWithState(t *testing.T) {
	e := setup(t)
	for range 3 {
		pi := create(t, e, A, "automatic")
		op := confirm(t, e, A, pi.ID)
		_ = e.observe(obs{opID: op.ID, outcome: "PROVIDER_EXECUTION_SUCCESS", amount: minor(1999)})
	}
	declined := create(t, e, A, "automatic")
	dop := confirm(t, e, A, declined.ID)
	_ = e.observe(obs{opID: dop.ID, outcome: "PROVIDER_DECLINED_FINAL"})

	succeeded := e.count(`SELECT count(*) FROM payment.payment_intents WHERE intent_status = 'SUCCEEDED'`)
	var capturedTotal int64
	e.scan(`SELECT coalesce(sum(captured_minor), 0) FROM payment.payment_intents`, nil, &capturedTotal)
	if succeeded != 3 || e.outboxCount(events.TypeCaptureConfirmed) != succeeded || capturedTotal != 3*1999 {
		t.Fatalf("succeeded=%d capture events=%d captured=%d", succeeded, e.outboxCount(events.TypeCaptureConfirmed), capturedTotal)
	}
	if e.outboxCount(events.TypeAttemptRequested) != e.count(`SELECT count(*) FROM payment.payment_operations`) {
		t.Fatal("every operation has exactly one attempt.requested")
	}
	if e.outboxCount(events.TypeIntentCreated) != e.count(`SELECT count(*) FROM payment.payment_intents`) {
		t.Fatal("every intent has exactly one intent.created")
	}
	// Audit completeness: for every intent, transitions 1..aggregate_version exist.
	gaps := e.count(`SELECT count(*) FROM payment.payment_intents i
		WHERE (SELECT count(*) FROM payment.intent_transitions t WHERE t.intent_id = i.intent_id) <> i.aggregate_version`)
	if gaps != 0 {
		t.Fatalf("%d intents have audit gaps", gaps)
	}
	// Each capture event's economic_effect_id is unique (BC-05 dedupe key).
	var dup int
	if err := e.relay.QueryRow(context.Background(), `SELECT count(*) - count(DISTINCT convert_from(envelope, 'UTF8')::jsonb #>> '{data,economic_effect_id}')
		FROM payment.outbox_events WHERE event_type = $1`, events.TypeCaptureConfirmed).Scan(&dup); err != nil {
		t.Fatal(err)
	}
	if dup != 0 {
		t.Fatal("duplicate economic_effect_id in capture events")
	}
}

// Database permissions and guards behind the reducer (PI-AT-011, -057; PI-023).
func TestDatabaseGuards(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	pi := create(t, e, A, "automatic")
	op := confirm(t, e, A, pi.ID)
	_ = e.observe(obs{opID: op.ID, outcome: "PROVIDER_EXECUTION_SUCCESS", amount: minor(1999)})
	tA := db.Tenant{Environment: "TEST", CellID: "cell_uk_01", LegalEntityID: "le_uk", TenantID: "ten_a"}
	try := func(pool interface {
		Begin(context.Context) (pgx.Tx, error)
	}, sql string) string {
		err := db.InTenantTx(ctx, pool.(db.Beginner), tA, func(tx pgx.Tx) error { _, err := tx.Exec(ctx, sql); return err })
		return sqlState(err)
	}
	for sql, want := range map[string]string{
		`UPDATE payment.payment_intents SET intent_status = 'FAILED', aggregate_version = aggregate_version + 1`: "23001", // terminal guard
		`UPDATE payment.payment_intents SET amount_requested_minor = 1`:                                          "42501", // column privilege
		`DELETE FROM payment.payment_intents`:                                                                    "42501",
		`UPDATE payment.intent_transitions SET to_status = 'FAILED'`:                                             "42501",
		`UPDATE payment.payment_operations SET resolution = 'CERTAIN_NEGATIVE'`:                                  "23001", // proven outcome is immutable
		`UPDATE payment.payment_intents SET captured_minor = 0, aggregate_version = aggregate_version + 1`:       "23001", // monotonic captured
		`TRUNCATE payment.provider_observations`:                                                                 "42501",
	} {
		if got := try(e.exec, sql); got != want {
			t.Errorf("zp_execution %q: SQLSTATE %s; want %s", sql, got, want)
		}
	}
	// Even the owner cannot rewrite history (support "direct SQL edit", PI-AT-057).
	mig := e.pg.Pool(t, "zp_migrator")
	for _, sql := range []string{
		`UPDATE payment.payment_intents SET intent_status = 'FAILED', aggregate_version = aggregate_version + 1`,
		`DELETE FROM payment.intent_transitions`,
		`DELETE FROM payment.payment_intents`,
	} {
		if got := try(mig, sql); got != "23001" {
			t.Errorf("owner %q: SQLSTATE %s; want 23001", sql, got)
		}
	}
	// Other deployables have no access to the payment schema.
	if _, err := e.pg.Pool(t, "zp_finance").Exec(ctx, `SELECT 1 FROM payment.payment_intents`); sqlState(err) != "42501" {
		t.Fatalf("zp_finance read payment: %v", err)
	}
}
