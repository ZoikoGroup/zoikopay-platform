package domain

import (
	"errors"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)

func amt(v int64) *int64 { return &v }

func created(t *testing.T, m CaptureMethod) Intent {
	t.Helper()
	d, err := Create(CreateParams{Amount: 1999, Currency: "GBP", CaptureMethod: m, HasToken: true, Now: t0})
	if err != nil {
		t.Fatal(err)
	}
	return d.Next
}

// confirmed returns an intent in PROCESSING with its CONFIRM operation active.
func confirmed(t *testing.T, m CaptureMethod) (Intent, Operation) {
	t.Helper()
	d, err := Confirm(created(t, m), 0, false, t0)
	if err != nil {
		t.Fatal(err)
	}
	op := Operation{ID: "op_confirm", Kind: OpConfirm, Resolution: ResPending, Requested: d.NewOp.Requested}
	i := d.Next
	i.Active = &op
	return i, op
}

func authorized(t *testing.T) (Intent, Operation) {
	t.Helper()
	i, op := confirmed(t, Manual)
	d := Observe(i, op, Observation{Outcome: ProviderAuthorized, Amount: amt(1999), Currency: "GBP"})
	if d.Disposition != Applied || d.Next.Status != RequiresCapture {
		t.Fatalf("authorize: %+v", d)
	}
	op.Resolution = ResPositive
	return d.Next, op
}

func TestCreateCommitsRequiresConfirmationWithTwoAuditedSteps(t *testing.T) {
	d, err := Create(CreateParams{Amount: 1999, Currency: "GBP", CaptureMethod: Manual, HasToken: true, Now: t0})
	if err != nil {
		t.Fatal(err)
	}
	if d.Next.Status != RequiresConfirmation || d.Next.Version != 2 || len(d.Steps) != 2 ||
		d.Steps[0].Input != InCreate || d.Steps[0].To != RequiresPaymentMethod || d.Steps[1].Input != InAttachToken {
		t.Fatalf("create = %+v", d)
	}
	if len(d.Emits) != 1 || d.Emits[0] != EmitIntentCreated || d.NewOp != nil {
		t.Fatal("create emits intent.created only and dispatches nothing (PI-AT-001)")
	}
	for name, p := range map[string]CreateParams{
		"zero amount":     {Amount: 0, Currency: "GBP", CaptureMethod: Manual, HasToken: true, Now: t0},
		"negative amount": {Amount: -5, Currency: "GBP", CaptureMethod: Manual, HasToken: true, Now: t0},
		"no token":        {Amount: 5, Currency: "GBP", CaptureMethod: Manual, Now: t0},
		"bad method":      {Amount: 5, Currency: "GBP", CaptureMethod: "LATER", HasToken: true, Now: t0},
		"past expiry":     {Amount: 5, Currency: "GBP", CaptureMethod: Manual, HasToken: true, Now: t0, ExpiresAt: t0},
	} {
		if _, err := Create(p); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v", name, err) // PI-AT-002
		}
	}
}

func TestConfirmAdmitsOneOperation(t *testing.T) {
	i := created(t, Automatic)
	d, err := Confirm(i, i.Version, false, t0)
	if err != nil || d.Next.Status != Processing || d.NewOp == nil || d.NewOp.Kind != OpConfirm || d.Emits[0] != EmitAttemptRequested {
		t.Fatalf("confirm = %+v, %v", d, err)
	}
	if _, err := Confirm(i, i.Version-1, false, t0); !errors.Is(err, ErrRevision) {
		t.Fatalf("stale revision err = %v", err)
	}
	p, _ := confirmed(t, Automatic)
	if _, err := Confirm(p, 0, false, t0); !errors.Is(err, ErrActiveOperation) {
		t.Fatalf("second confirm err = %v (PI-INV-03)", err)
	}
	exp := i
	exp.ExpiresAt = t0
	if _, err := Confirm(exp, 0, false, t0); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("confirm after expiry err = %v", err)
	}
}

func TestAutomaticCaptureSuccess(t *testing.T) {
	i, op := confirmed(t, Automatic)
	d := Observe(i, op, Observation{Outcome: ProviderExecutionSuccess, Amount: amt(1999), Currency: "GBP"})
	if d.Next.Status != Succeeded || d.Next.Captured != 1999 || d.OpResolution != ResPositive || d.Emits[0] != EmitCaptureConfirmed || d.Next.Active != nil {
		t.Fatalf("auto success = %+v", d) // PI-AT-026
	}
	// An authorization alone is not the automatic-capture effect.
	d = Observe(i, op, Observation{Outcome: ProviderAuthorized, Amount: amt(1999), Currency: "GBP"})
	if d.Disposition != Recorded || len(d.Steps) != 0 || d.Next.Status != Processing {
		t.Fatalf("auth on automatic = %+v", d)
	}
}

func TestManualAuthorizeThenCapture(t *testing.T) {
	i, _ := authorized(t) // PI-AT-025
	if i.Authorized != 1999 || i.Captured != 0 || i.Active != nil {
		t.Fatalf("authorized = %+v", i)
	}
	if _, err := Capture(i, 0, 2000); !errors.Is(err, ErrInvalid) {
		t.Fatalf("over-capture err = %v (PI-AT-033)", err)
	}
	if _, err := Capture(i, 0, 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("zero capture err = %v (PI-AT-034)", err)
	}
	if _, err := Capture(i, 0, 1000); !errors.Is(err, ErrCapability) {
		t.Fatalf("partial capture err = %v (PI-028, PI-AT-035)", err)
	}
	d, err := Capture(i, 0, 1999)
	if err != nil || d.Next.Reserved != 1999 || d.NewOp.Kind != OpCapture || d.Next.Status != RequiresCapture {
		t.Fatalf("capture request = %+v, %v", d, err)
	}
	cap := Operation{ID: "op_capture", Kind: OpCapture, Resolution: ResPending, Requested: 1999}
	ci := d.Next
	ci.Active = &cap
	if _, err := Capture(ci, 0, 1999); !errors.Is(err, ErrActiveOperation) {
		t.Fatalf("second capture err = %v (PI-AT-020)", err)
	}
	if _, err := Cancel(ci, 0); !errors.Is(err, ErrActiveOperation) {
		t.Fatalf("void during capture err = %v (06-01 §9.2)", err)
	}
	f := Observe(ci, cap, Observation{Outcome: CaptureConfirmedFinal, Amount: amt(1999), Currency: "GBP"})
	if f.Next.Status != Succeeded || f.Next.Captured != 1999 || f.Next.Reserved != 0 || f.Emits[0] != EmitCaptureConfirmed {
		t.Fatalf("capture confirmed = %+v", f)
	}
	n := Observe(ci, cap, Observation{Outcome: CaptureFailedNoEffect})
	if n.Next.Status != RequiresCapture || n.Next.Reserved != 0 || n.OpResolution != ResNegative {
		t.Fatalf("capture no effect = %+v", n)
	}
	u := Observe(ci, cap, Observation{Outcome: CaptureUnknown})
	if u.Next.Status != RequiresCapture || u.OpResolution != ResUnknown || u.Next.Reserved != 1999 || u.Emits[0] != EmitOutcomeUnknown {
		t.Fatalf("capture unknown = %+v (hold reservation, inquire)", u)
	}
}

func TestDeclines(t *testing.T) {
	i, op := confirmed(t, Automatic)
	r := Observe(i, op, Observation{Outcome: ProviderDeclinedRetryable})
	if r.Next.Status != RequiresPaymentMethod || !r.ClearToken || r.Next.HasToken || r.OpResolution != ResNegative {
		t.Fatalf("retryable = %+v", r)
	}
	// T4: new token + newly keyed confirm.
	d, err := Confirm(r.Next, 0, true, t0)
	if err != nil || len(d.Steps) != 2 || d.Steps[0].Input != InAttachToken || d.Next.Status != Processing {
		t.Fatalf("retry confirm = %+v, %v", d, err)
	}
	if _, err := Confirm(r.Next, 0, false, t0); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("confirm without token err = %v (PI-AT-010)", err)
	}
	f := Observe(i, op, Observation{Outcome: ProviderDeclinedFinal})
	if f.Next.Status != Failed || f.OpResolution != ResNegative {
		t.Fatalf("final = %+v", f)
	}
	ne := Observe(i, op, Observation{Outcome: ProviderNoEffectProven})
	if ne.Next.Status != Failed {
		t.Fatalf("no effect, not retry-eligible = %+v", ne)
	}
	ner := Observe(i, op, Observation{Outcome: ProviderNoEffectProven, RetryEligible: true})
	if ner.Next.Status != RequiresPaymentMethod {
		t.Fatalf("no effect, retry-eligible = %+v", ner)
	}
}

func TestUnknownIsNeverFailure(t *testing.T) {
	i, op := confirmed(t, Automatic)
	d := Observe(i, op, Observation{Outcome: ProviderOutcomeUnknown})
	if d.Next.Status != Processing || d.OpResolution != ResUnknown || d.Emits[0] != EmitOutcomeUnknown {
		t.Fatalf("unknown = %+v (PI-AT-027, PI-AT-028)", d)
	}
	i2 := d.Next
	op.Resolution = ResUnknown
	if again := Observe(i2, op, Observation{Outcome: ProviderOutcomeUnknown}); again.Disposition != Recorded || len(again.Steps) != 0 {
		t.Fatalf("repeat unknown = %+v", again)
	}
	if _, err := Confirm(i2, 0, false, t0); err == nil {
		t.Fatal("unknown must block new effects (PI-INV-05)")
	}
	// Inquiry proves success: the original operation progresses once (T3).
	s := Observe(i2, op, Observation{Outcome: ProviderExecutionSuccess, Amount: amt(1999), Currency: "GBP"})
	if s.Next.Status != Succeeded || s.OpResolution != ResPositive {
		t.Fatalf("after inquiry = %+v", s)
	}
}

func TestCustomerAction(t *testing.T) {
	i, op := confirmed(t, Automatic)
	c := Observe(i, op, Observation{Outcome: ProviderChallenge, HasAction: true})
	if c.Next.Status != RequiresCustomerAction || !c.SetAction || c.OpResolution != "" {
		t.Fatalf("challenge = %+v", c)
	}
	done := Observe(c.Next, op, Observation{Outcome: CustomerActionComplete})
	if done.Next.Status != Processing || !done.ClearAction {
		t.Fatalf("completed = %+v (T2)", done)
	}
	exp := Observe(c.Next, op, Observation{Outcome: CustomerActionExpired})
	if exp.Next.Status != Processing || exp.OpResolution != ResUnknown || exp.Emits[0] != EmitOutcomeUnknown {
		t.Fatalf("action expired = %+v (inquire before terminal failure)", exp)
	}
	early := Observe(c.Next, op, Observation{Outcome: ProviderExecutionSuccess, Amount: amt(1999), Currency: "GBP"})
	if early.Disposition != Recorded || early.Case != CaseQuarantine || early.Next.Status != RequiresCustomerAction {
		t.Fatalf("success before completion = %+v", early)
	}
}

func TestCancelRules(t *testing.T) {
	i := created(t, Manual)
	d, err := Cancel(i, 0)
	if err != nil || d.Next.Status != Canceled || d.NewOp != nil {
		t.Fatalf("cancel before dispatch = %+v, %v (PI-AT-013)", d, err)
	}
	// In flight: request recorded, never canceled from a timeout (§8.2, PI-AT-037).
	p, op := confirmed(t, Manual)
	c, err := Cancel(p, 0)
	if err != nil || c.Next.Status != Processing || !c.Next.CancelRequested {
		t.Fatalf("cancel in flight = %+v, %v", c, err)
	}
	if _, err := Cancel(c.Next, 0); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("second cancel request err = %v", err)
	}
	// Authorization arrives: void is queued automatically.
	a := Observe(c.Next, op, Observation{Outcome: ProviderAuthorized, Amount: amt(1999), Currency: "GBP"})
	if a.Next.Status != RequiresCapture || a.NewOp == nil || a.NewOp.Kind != OpVoid || len(a.Steps) != 2 {
		t.Fatalf("auth after cancel request = %+v", a)
	}
	// No-effect proof with a cancel request ends CANCELED.
	n := Observe(c.Next, op, Observation{Outcome: ProviderDeclinedFinal})
	if n.Next.Status != Canceled {
		t.Fatalf("decline after cancel request = %+v", n)
	}
	// Authorized: cancel sends a void and waits for proof (PI-030, PI-AT-038).
	au, _ := authorized(t)
	v, err := Cancel(au, 0)
	if err != nil || v.NewOp == nil || v.NewOp.Kind != OpVoid || v.Next.Status != RequiresCapture {
		t.Fatalf("void request = %+v, %v", v, err)
	}
	vop := Operation{ID: "op_void", Kind: OpVoid, Resolution: ResPending, Requested: 1999}
	vi := v.Next
	vi.Active = &vop
	if ok := Observe(vi, vop, Observation{Outcome: VoidConfirmed}); ok.Next.Status != Canceled || ok.Next.Captured != 0 {
		t.Fatalf("void confirmed = %+v", ok)
	}
	if no := Observe(vi, vop, Observation{Outcome: ProviderNoEffectProven}); no.Next.Status != RequiresCapture || no.OpResolution != ResNegative {
		t.Fatalf("void no effect = %+v", no)
	}
	// Succeeded payments are never canceled.
	sp, sop := confirmed(t, Automatic)
	s := Observe(sp, sop, Observation{Outcome: ProviderExecutionSuccess, Amount: amt(1999), Currency: "GBP"})
	if _, err := Cancel(s.Next, 0); !errors.Is(err, ErrNotCancelable) {
		t.Fatalf("cancel succeeded err = %v", err)
	}
}

func TestTerminalNeverRegresses(t *testing.T) {
	i, op := confirmed(t, Automatic)
	s := Observe(i, op, Observation{Outcome: ProviderExecutionSuccess, Amount: amt(1999), Currency: "GBP"})
	done := s.Next
	op.Resolution = ResPositive
	// Late duplicate of the same fact: recorded, no transition (T8, PI-AT-024).
	if d := Observe(done, op, Observation{Outcome: ProviderExecutionSuccess, Amount: amt(1999), Currency: "GBP"}); d.Disposition != Duplicate || len(d.Steps) != 0 {
		t.Fatalf("late duplicate = %+v", d)
	}
	// Contradiction: decline after proven success → CONFLICTED, frozen, case (PI-AT-031).
	c := Observe(done, op, Observation{Outcome: ProviderDeclinedFinal})
	if c.Disposition != Conflict || c.Next.Status != Succeeded || !c.Next.Frozen || c.Case != CaseConflict || c.OpResolution != ResConflicted {
		t.Fatalf("contradiction = %+v", c)
	}
	for _, s := range []Status{Succeeded, Failed, Canceled, Expired} {
		x := Intent{Status: s, Version: 5, HasToken: true}
		if _, err := Confirm(x, 0, false, t0); err == nil {
			t.Errorf("confirm from %s allowed (PI-AT-012)", s)
		}
		if _, err := Capture(x, 0, 1); err == nil {
			t.Errorf("capture from %s allowed", s)
		}
	}
}

func TestEvidenceMustMatchExactly(t *testing.T) {
	i, op := confirmed(t, Manual)
	for name, ob := range map[string]Observation{
		"partial authorization": {Outcome: ProviderAuthorized, Amount: amt(1000), Currency: "GBP"},
		"wrong currency":        {Outcome: ProviderAuthorized, Amount: amt(1999), Currency: "EUR"},
		"no amount":             {Outcome: ProviderAuthorized, Currency: "GBP"},
		"execution on manual":   {Outcome: ProviderExecutionSuccess, Amount: amt(1999), Currency: "GBP"},
	} {
		d := Observe(i, op, ob)
		if d.Disposition != Conflict || !d.Next.Frozen || d.Next.Status != Processing {
			t.Errorf("%s: %+v", name, d)
		}
	}
	// Frozen intents accept no new effects.
	f := Observe(i, op, Observation{Outcome: ProviderAuthorized, Amount: amt(1000), Currency: "GBP"})
	if _, err := Cancel(f.Next, 0); !errors.Is(err, ErrFrozen) {
		t.Fatalf("cancel frozen err = %v", err)
	}
}

func TestQuarantine(t *testing.T) {
	i, op := confirmed(t, Manual)
	other := Operation{ID: "op_other", Kind: OpConfirm, Resolution: ResPending, Requested: 1999}
	if d := Observe(i, other, Observation{Outcome: ProviderPending}); d.Disposition != Quarantined {
		t.Fatalf("not active op = %+v", d)
	}
	if d := Observe(i, op, Observation{Outcome: CaptureConfirmedFinal, Amount: amt(1999), Currency: "GBP"}); d.Disposition != Quarantined {
		t.Fatalf("outcome for wrong kind = %+v", d)
	}
	if d := Observe(i, op, Observation{Outcome: "PAID"}); d.Disposition != Quarantined {
		t.Fatalf("raw provider string = %+v (PI-INV-21)", d)
	}
}

func TestExpiry(t *testing.T) {
	i := created(t, Manual)
	i.ExpiresAt = t0.Add(time.Hour)
	if _, ok := Expire(i, t0); ok {
		t.Fatal("not yet expired")
	}
	d, ok := Expire(i, t0.Add(2*time.Hour))
	if !ok || d.Next.Status != Expired {
		t.Fatalf("expire pre-confirm = %+v (PI-AT-014)", d)
	}
	p, _ := confirmed(t, Manual)
	p.ExpiresAt = t0
	f, ok := Expire(p, t0.Add(time.Hour))
	if !ok || f.Next.Status != Processing || !f.FlagExpiry || f.Case != CaseExpiredUnres {
		t.Fatalf("expire processing = %+v (PI-AT-015)", f)
	}
	if _, ok := Expire(f.Next, t0.Add(2*time.Hour)); ok {
		t.Fatal("expiry must be flagged once")
	}
	au, op := authorized(t)
	if d := Observe(au, op, Observation{Outcome: AuthExpiredUncaptured}); d.Next.Status != Expired {
		t.Fatalf("auth expired = %+v (PI-AT-040)", d)
	}
}
