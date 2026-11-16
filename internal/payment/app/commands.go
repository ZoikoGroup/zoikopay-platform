package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/payment/domain"
	"github.com/zoiko/zoikopay/internal/payment/store"
	"github.com/zoiko/zoikopay/internal/platform/apierror"
	"github.com/zoiko/zoikopay/internal/platform/idempotency"
	"github.com/zoiko/zoikopay/internal/platform/ids"
	"github.com/zoiko/zoikopay/internal/platform/money"
)

// CreateRequest is the validated body of POST /v1/payment_intents.
type CreateRequest struct {
	Amount             money.Minor
	Currency           string
	CaptureMethod      string // "automatic" | "manual"
	PaymentMethodToken string
	MerchantReference  *string
	ExpiresAt          *time.Time
}

// ConfirmRequest is the body of POST .../confirm.
type ConfirmRequest struct {
	PaymentMethodToken *string // only after a retryable decline (06-01 T4)
	ExpectedRevision   int64   // 0: not checked
}

// CaptureRequest is the body of POST .../capture.
type CaptureRequest struct {
	Amount           money.Minor
	ExpectedRevision int64
}

// CancelRequest is the body of POST .../cancel.
type CancelRequest struct {
	ExpectedRevision int64
}

// Route templates (idempotency scope, 04-08 §6.1).
const (
	routeCreate  = "/v1/payment_intents"
	routeConfirm = "/v1/payment_intents/{payment_intent_id}/confirm"
	routeCapture = "/v1/payment_intents/{payment_intent_id}/capture"
	routeCancel  = "/v1/payment_intents/{payment_intent_id}/cancel"
)

type command struct {
	name     string // operation kind, e.g. payment_intent.confirm
	route    string
	intentID string // path parameter, "" for create
	body     map[string]any
	run      func(ctx context.Context, tx pgx.Tx, q *store.Queries) (Result, string, error)
}

// execute runs cmd under the idempotency protocol (04-08 §8.1, 04-02 §7).
func (s *Service) execute(ctx context.Context, sc Scope, key idempotency.Key, cmd command) (Result, error) {
	params := map[string]string{}
	if cmd.intentID != "" {
		params["payment_intent_id"] = cmd.intentID
	}
	fp, err := idempotency.Fingerprint(idempotency.Input{OperationKind: cmd.name, Method: http.MethodPost,
		Route: cmd.route, PathParams: params, Body: cmd.body})
	if err != nil {
		return Result{}, apierror.New(apierror.ValidationError, "Request cannot be fingerprinted.")
	}
	scope := idempotency.Scope{Environment: sc.Environment, CellID: sc.CellID, LegalEntityID: sc.LegalEntityID,
		TenantID: sc.TenantID, MerchantID: sc.MerchantID, ClientID: sc.ClientID, PrincipalID: sc.PrincipalID,
		APIMajor: 1, Method: http.MethodPost, RouteTemplate: cmd.route, OperationKind: cmd.name}

	var res Result
	err = s.inTenant(ctx, sc, func(tx pgx.Tx) error {
		q := store.New(tx)
		reg := s.registry()
		r, err := reg.Reserve(ctx, tx, scope, key, fp, s.IDs.NewInternal())
		if err != nil {
			return err
		}
		switch r.Outcome {
		case idempotency.Mismatch:
			return apierror.New(apierror.IdempotencyFingerprintMismatch, "This Idempotency-Key was used with a different request. Use a new key for a new command.")
		case idempotency.InProgress:
			return apierror.New(apierror.OperationInProgress, "A request with this Idempotency-Key is still being processed.")
		case idempotency.Replay:
			res, err = s.replay(ctx, q, sc, r)
			if err != nil {
				return err
			}
			res.Replayed = true
			return s.logCommand(ctx, q, sc, cmd.name, res, "REPLAYED", "")
		}
		var rid string
		res, rid, err = cmd.run(ctx, tx, q)
		if err != nil {
			return err
		}
		if err := reg.Complete(ctx, tx, r.OperationID, res.Status, rid); err != nil {
			return err
		}
		return s.logCommand(ctx, q, sc, cmd.name, res, "ACCEPTED", "")
	})
	if err != nil {
		p := problem(err)
		if p.Code == apierror.InternalError {
			s.log().Error("payment command failed", "command", cmd.name, "request_id", sc.RequestID, "error", err)
		}
		s.logRefusal(ctx, sc, cmd.name, cmd.intentID, p)
		return Result{}, p
	}
	return res, nil
}

// replay returns the stored result of an identical retry: the same resource
// in its current state, never a second effect (PI-INV-04, PI-012).
func (s *Service) replay(ctx context.Context, q *store.Queries, sc Scope, r idempotency.Result) (Result, error) {
	res := Result{Status: r.ResponseStatus}
	switch {
	case strings.HasPrefix(r.ResourceID, string(ids.Operation)):
		op, err := q.GetOperationByPublicID(ctx, store.GetOperationByPublicIDParams{PublicID: r.ResourceID, MerchantID: sc.MerchantID, Environment: sc.Environment})
		if err != nil {
			return res, err
		}
		in, err := q.LockIntentByID(ctx, op.IntentID)
		if err != nil {
			return res, err
		}
		v := operationView(op, in.PublicID)
		res.Op = &v
	case strings.HasPrefix(r.ResourceID, string(ids.PaymentIntent)):
		in, err := q.GetIntentByPublicID(ctx, store.GetIntentByPublicIDParams{PublicID: r.ResourceID, MerchantID: sc.MerchantID, Environment: sc.Environment})
		if err != nil {
			return res, err
		}
		v, err := s.view(ctx, q, in)
		if err != nil {
			return res, err
		}
		res.Intent = &v
	default:
		return res, fmt.Errorf("stored idempotency result has no resource")
	}
	return res, nil
}

func (s *Service) logCommand(ctx context.Context, q *store.Queries, sc Scope, name string, res Result, outcome, code string) error {
	var intentID, opID *string
	if res.Intent != nil {
		intentID = &res.Intent.ID
	}
	if res.Op != nil {
		intentID, opID = &res.Op.PaymentIntentID, &res.Op.ID
	}
	var pc *string
	if code != "" {
		pc = &code
	}
	return q.InsertCommandLog(ctx, store.InsertCommandLogParams{CommandLogID: s.IDs.NewInternal(), TenantID: sc.TenantID,
		MerchantID: sc.MerchantID, Command: name, IntentPublicID: intentID, OperationPublicID: opID, Outcome: outcome,
		ProblemCode: pc, Actor: sc.PrincipalID, RequestID: sc.RequestID, RecordedAtUtc: s.now()})
}

// logRefusal records a refused command in its own transaction: the command's
// work rolled back, but the refusal itself is audited.
func (s *Service) logRefusal(ctx context.Context, sc Scope, name, intentID string, p *apierror.Problem) {
	if !sc.valid() {
		return
	}
	err := s.inTenant(context.WithoutCancel(ctx), sc, func(tx pgx.Tx) error {
		res := Result{}
		if intentID != "" {
			res.Intent = &IntentView{ID: intentID}
		}
		return s.logCommand(ctx, store.New(tx), sc, name, res, "REFUSED", string(p.Code))
	})
	if err != nil {
		s.log().Error("could not audit refused payment command", "command", name, "request_id", sc.RequestID, "error", err)
	}
}

// decide asks BC-02 at the effect point; any error or missing decision fails closed.
func (s *Service) decide(ctx context.Context, sc Scope, a Action, r PolicyRequest) (PolicyDecision, error) {
	if s.Eligibility == nil {
		return PolicyDecision{}, apierror.New(apierror.TemporarilyUnavailable, "Payment eligibility is unavailable. No payment was changed.")
	}
	d, err := s.Eligibility.Decide(ctx, sc, a, r)
	if err != nil {
		s.log().Warn("eligibility unavailable; failing closed", "action", a, "request_id", sc.RequestID, "error", err)
		return PolicyDecision{}, apierror.New(apierror.TemporarilyUnavailable, "Payment eligibility is unavailable. No payment was changed.")
	}
	if !d.Allowed || d.PolicyVersion == "" {
		return d, apierror.New(apierror.CapabilityNotAvailable, "This payment is not permitted for this merchant, cell or method.")
	}
	return d, nil
}

func (s *Service) verifyToken(ctx context.Context, sc Scope, token string) error {
	if s.Vault == nil {
		return apierror.New(apierror.TemporarilyUnavailable, "The payment method vault is unavailable. No payment was changed.")
	}
	if err := s.Vault.Verify(ctx, sc, token); err != nil {
		if errors.Is(err, ErrTokenRejected) {
			return problem(ErrTokenRejected)
		}
		return apierror.New(apierror.TemporarilyUnavailable, "The payment method vault is unavailable. No payment was changed.")
	}
	return nil
}

// ---------------------------------------------------------------------------

// CreateIntent is POST /v1/payment_intents (04-02 §6.1, 06-01 §6).
func (s *Service) CreateIntent(ctx context.Context, sc Scope, key idempotency.Key, req CreateRequest) (Result, error) {
	m := money.Money{Amount: req.Amount, Currency: money.Currency(req.Currency)}
	var fields []apierror.FieldError
	if err := m.ValidateTransaction(); err != nil {
		fields = append(fields, apierror.FieldError{Field: "amount_minor", Reason: err.Error()})
	}
	method := domain.CaptureMethod(strings.ToUpper(req.CaptureMethod))
	if req.CaptureMethod != "automatic" && req.CaptureMethod != "manual" {
		fields = append(fields, apierror.FieldError{Field: "capture_method", Reason: "must be automatic or manual"})
	}
	if l := len(req.PaymentMethodToken); l == 0 || l > 256 {
		fields = append(fields, apierror.FieldError{Field: "payment_method_token", Reason: "required, at most 256 characters"})
	}
	if req.MerchantReference != nil {
		if reason := checkReference(*req.MerchantReference); reason != "" {
			fields = append(fields, apierror.FieldError{Field: "merchant_reference", Reason: reason})
		}
	}
	now := s.now()
	var expires time.Time
	if req.ExpiresAt != nil {
		expires = req.ExpiresAt.UTC()
	}
	d, err := domain.Create(domain.CreateParams{Amount: int64(req.Amount), Currency: req.Currency, CaptureMethod: method,
		HasToken: req.PaymentMethodToken != "", ExpiresAt: expires, Now: now})
	if err != nil && len(fields) == 0 {
		fields = append(fields, apierror.FieldError{Field: "body", Reason: err.Error()})
	}
	if len(fields) > 0 {
		p := apierror.Validation("The payment intent is not valid.", fields...)
		s.logRefusal(ctx, sc, string(ActionCreate), "", p)
		return Result{}, p
	}
	if err := s.verifyToken(ctx, sc, req.PaymentMethodToken); err != nil {
		s.logRefusal(ctx, sc, string(ActionCreate), "", problem(err))
		return Result{}, err
	}
	pol, err := s.decide(ctx, sc, ActionCreate, PolicyRequest{Amount: int64(req.Amount), Currency: req.Currency, CaptureMethod: method})
	if err != nil {
		s.logRefusal(ctx, sc, string(ActionCreate), "", problem(err))
		return Result{}, err
	}

	body := map[string]any{"amount_minor": req.Amount.String(), "currency": req.Currency, "capture_method": req.CaptureMethod,
		"payment_method_token": req.PaymentMethodToken, "merchant_reference": nil, "expires_at": nil}
	if req.MerchantReference != nil {
		body["merchant_reference"] = *req.MerchantReference
	}
	if req.ExpiresAt != nil {
		body["expires_at"] = expires.Format(time.RFC3339Nano)
	}
	return s.execute(ctx, sc, key, command{name: string(ActionCreate), route: routeCreate, body: body,
		run: func(ctx context.Context, tx pgx.Tx, q *store.Queries) (Result, string, error) {
			row := store.PaymentPaymentIntent{
				IntentID: s.IDs.NewInternal(), PublicID: s.IDs.NewPublic(ids.PaymentIntent), Environment: sc.Environment,
				TenantID: sc.TenantID, MerchantID: sc.MerchantID, CellID: sc.CellID, LegalEntityID: sc.LegalEntityID,
				MerchantReference: req.MerchantReference, AmountRequestedMinor: int64(req.Amount), Currency: req.Currency,
				CurrencySpecVersion: money.SpecVersion, CaptureMethod: string(method), PaymentMethodTokenRef: &req.PaymentMethodToken,
				IntentStatus: string(d.Next.Status), AggregateVersion: d.Next.Version, PolicyVersion: pol.PolicyVersion,
				CreatedAtUtc: now, UpdatedAtUtc: now,
			}
			if req.ExpiresAt != nil {
				row.ExpiresAtUtc = &expires
			}
			if err := q.InsertIntent(ctx, store.InsertIntentParams{IntentID: row.IntentID, PublicID: row.PublicID,
				Environment: row.Environment, TenantID: row.TenantID, MerchantID: row.MerchantID, CellID: row.CellID,
				LegalEntityID: row.LegalEntityID, MerchantReference: row.MerchantReference, AmountRequestedMinor: row.AmountRequestedMinor,
				Currency: row.Currency, CurrencySpecVersion: row.CurrencySpecVersion, CaptureMethod: row.CaptureMethod,
				PaymentMethodTokenRef: row.PaymentMethodTokenRef, IntentStatus: row.IntentStatus, AggregateVersion: row.AggregateVersion,
				PolicyVersion: row.PolicyVersion, ExpiresAtUtc: row.ExpiresAtUtc, CreatedAtUtc: now}); err != nil {
				return Result{}, "", fmt.Errorf("insert intent: %w", err)
			}
			// Audit both steps (CREATE, ATTACH_TOKEN) and emit intent.created,
			// reusing apply's audit and outbox code from a version-0 view.
			base := row
			base.AggregateVersion = 0
			if err := s.auditCreate(ctx, tx, q, base, row, d, sc, pol.PolicyVersion); err != nil {
				return Result{}, "", err
			}
			if row.ExpiresAtUtc != nil {
				if err := q.ScheduleWork(ctx, store.ScheduleWorkParams{Kind: "INTENT_EXPIRY", RefID: row.IntentID,
					Environment: row.Environment, TenantID: row.TenantID, CellID: row.CellID, LegalEntityID: row.LegalEntityID,
					DueAtUtc: expires}); err != nil {
					return Result{}, "", fmt.Errorf("schedule expiry: %w", err)
				}
			}
			v, err := s.view(ctx, q, row)
			if err != nil {
				return Result{}, "", err
			}
			return Result{Status: http.StatusCreated, Intent: &v}, row.PublicID, nil
		}})
}

// ConfirmIntent is POST .../confirm (04-02 §6.2, 06-01 CONFIRM).
func (s *Service) ConfirmIntent(ctx context.Context, sc Scope, key idempotency.Key, intentID string, req ConfirmRequest) (Result, error) {
	if req.PaymentMethodToken != nil {
		if l := len(*req.PaymentMethodToken); l == 0 || l > 256 {
			return Result{}, apierror.Validation("The confirmation is not valid.", apierror.FieldError{Field: "payment_method_token", Reason: "1 to 256 characters"})
		}
	}
	snap, err := s.snapshot(ctx, sc, intentID)
	if err != nil {
		p := problem(err)
		s.logRefusal(ctx, sc, string(ActionConfirm), intentID, p)
		return Result{}, p
	}
	if req.PaymentMethodToken != nil {
		if err := s.verifyToken(ctx, sc, *req.PaymentMethodToken); err != nil {
			s.logRefusal(ctx, sc, string(ActionConfirm), intentID, problem(err))
			return Result{}, err
		}
	}
	pol, err := s.decide(ctx, sc, ActionConfirm, PolicyRequest{Amount: snap.AmountRequestedMinor, Currency: snap.Currency,
		CaptureMethod: domain.CaptureMethod(snap.CaptureMethod), IntentID: intentID})
	if err != nil {
		s.logRefusal(ctx, sc, string(ActionConfirm), intentID, problem(err))
		return Result{}, err
	}
	body := map[string]any{"payment_method_token": nil, "expected_revision": req.ExpectedRevision}
	if req.PaymentMethodToken != nil {
		body["payment_method_token"] = *req.PaymentMethodToken
	}
	return s.execute(ctx, sc, key, command{name: string(ActionConfirm), route: routeConfirm, intentID: intentID, body: body,
		run: func(ctx context.Context, tx pgx.Tx, q *store.Queries) (Result, string, error) {
			l, err := s.lockScoped(ctx, q, sc, intentID)
			if err != nil {
				return Result{}, "", err
			}
			d, err := domain.Confirm(l.domain(), req.ExpectedRevision, req.PaymentMethodToken != nil, s.now())
			if err != nil {
				return Result{}, "", err
			}
			a, err := s.apply(ctx, tx, l, d, applyMeta{actor: sc.PrincipalID, correlationID: sc.CorrelationID,
				policyVersion: pol.PolicyVersion, token: req.PaymentMethodToken})
			if err != nil {
				return Result{}, "", err
			}
			v := operationView(*a.newOp, a.intent.PublicID)
			return Result{Status: http.StatusAccepted, Op: &v}, a.newOp.PublicID, nil
		}})
}

// CaptureIntent is POST .../capture (04-02 §6.3, 06-01 §5.2).
func (s *Service) CaptureIntent(ctx context.Context, sc Scope, key idempotency.Key, intentID string, req CaptureRequest) (Result, error) {
	if req.Amount <= 0 {
		return Result{}, apierror.Validation("The capture is not valid.", apierror.FieldError{Field: "amount_minor", Reason: "must be positive"})
	}
	snap, err := s.snapshot(ctx, sc, intentID)
	if err != nil {
		p := problem(err)
		s.logRefusal(ctx, sc, string(ActionCapture), intentID, p)
		return Result{}, p
	}
	pol, err := s.decide(ctx, sc, ActionCapture, PolicyRequest{Amount: int64(req.Amount), Currency: snap.Currency,
		CaptureMethod: domain.CaptureMethod(snap.CaptureMethod), IntentID: intentID})
	if err != nil {
		s.logRefusal(ctx, sc, string(ActionCapture), intentID, problem(err))
		return Result{}, err
	}
	body := map[string]any{"amount_minor": req.Amount.String(), "expected_revision": req.ExpectedRevision}
	return s.execute(ctx, sc, key, command{name: string(ActionCapture), route: routeCapture, intentID: intentID, body: body,
		run: func(ctx context.Context, tx pgx.Tx, q *store.Queries) (Result, string, error) {
			l, err := s.lockScoped(ctx, q, sc, intentID)
			if err != nil {
				return Result{}, "", err
			}
			d, err := domain.Capture(l.domain(), req.ExpectedRevision, int64(req.Amount))
			if err != nil {
				return Result{}, "", err
			}
			a, err := s.apply(ctx, tx, l, d, applyMeta{actor: sc.PrincipalID, correlationID: sc.CorrelationID, policyVersion: pol.PolicyVersion})
			if err != nil {
				return Result{}, "", err
			}
			v := operationView(*a.newOp, a.intent.PublicID)
			return Result{Status: http.StatusAccepted, Op: &v}, a.newOp.PublicID, nil
		}})
}

// CancelIntent is POST .../cancel (04-02 §6.4, 06-01 §8.2). Cancellation
// reduces exposure, so it is not blocked by an eligibility outage.
func (s *Service) CancelIntent(ctx context.Context, sc Scope, key idempotency.Key, intentID string, req CancelRequest) (Result, error) {
	body := map[string]any{"expected_revision": req.ExpectedRevision}
	return s.execute(ctx, sc, key, command{name: string(ActionCancel), route: routeCancel, intentID: intentID, body: body,
		run: func(ctx context.Context, tx pgx.Tx, q *store.Queries) (Result, string, error) {
			l, err := s.lockScoped(ctx, q, sc, intentID)
			if err != nil {
				return Result{}, "", err
			}
			d, err := domain.Cancel(l.domain(), req.ExpectedRevision)
			if err != nil {
				return Result{}, "", err
			}
			a, err := s.apply(ctx, tx, l, d, applyMeta{actor: sc.PrincipalID, correlationID: sc.CorrelationID})
			if err != nil {
				return Result{}, "", err
			}
			if a.newOp != nil { // void sent to the provider
				v := operationView(*a.newOp, a.intent.PublicID)
				return Result{Status: http.StatusAccepted, Op: &v}, a.newOp.PublicID, nil
			}
			v, err := s.view(ctx, q, a.intent)
			if err != nil {
				return Result{}, "", err
			}
			return Result{Status: http.StatusOK, Intent: &v}, a.intent.PublicID, nil
		}})
}

// ---------------------------------------------------------------------------
// Reads (04-02 §6.6). Out-of-scope resources are masked as 404.

// GetIntent is GET /v1/payment_intents/{id}.
func (s *Service) GetIntent(ctx context.Context, sc Scope, intentID string) (IntentView, error) {
	var v IntentView
	err := s.inTenant(ctx, sc, func(tx pgx.Tx) error {
		q := store.New(tx)
		in, err := q.GetIntentByPublicID(ctx, store.GetIntentByPublicIDParams{PublicID: intentID, MerchantID: sc.MerchantID, Environment: sc.Environment})
		if err != nil {
			return err
		}
		v, err = s.view(ctx, q, in)
		return err
	})
	return v, problemOrNil(err)
}

// Page is one page of a list.
type Page struct {
	Data       []IntentView `json:"data"`
	HasMore    bool         `json:"has_more"`
	NextCursor *string      `json:"next_cursor"`
}

// MaxPageSize bounds list pages (04-02 §6.6 "max 100 records proposal").
const MaxPageSize = 100

// ListIntents is GET /v1/payment_intents with an opaque cursor.
func (s *Service) ListIntents(ctx context.Context, sc Scope, cursor string, limit int) (Page, error) {
	if limit <= 0 || limit > MaxPageSize {
		limit = MaxPageSize
	}
	after := ""
	if cursor != "" {
		id, err := ids.Parse(ids.PaymentIntent, cursor)
		if err != nil {
			return Page{}, apierror.Validation("The cursor is not valid.", apierror.FieldError{Field: "cursor", Reason: "unknown cursor"})
		}
		after = id
	}
	var p Page
	err := s.inTenant(ctx, sc, func(tx pgx.Tx) error {
		q := store.New(tx)
		rows, err := q.ListIntents(ctx, store.ListIntentsParams{MerchantID: sc.MerchantID, Environment: sc.Environment,
			AfterPublicID: after, PageSize: int32(limit + 1)}) //nolint:gosec // G115: limit is bounded by MaxPageSize.
		if err != nil {
			return err
		}
		p.Data = []IntentView{}
		for k, r := range rows {
			if k == limit {
				p.HasMore = true
				break
			}
			v, err := s.view(ctx, q, r)
			if err != nil {
				return err
			}
			p.Data = append(p.Data, v)
		}
		if p.HasMore {
			last := p.Data[len(p.Data)-1].ID
			p.NextCursor = &last
		}
		return nil
	})
	return p, problemOrNil(err)
}

// GetOperation is GET /v1/operations/{id}.
func (s *Service) GetOperation(ctx context.Context, sc Scope, operationID string) (OperationView, error) {
	var v OperationView
	err := s.inTenant(ctx, sc, func(tx pgx.Tx) error {
		q := store.New(tx)
		op, err := q.GetOperationByPublicID(ctx, store.GetOperationByPublicIDParams{PublicID: operationID, MerchantID: sc.MerchantID, Environment: sc.Environment})
		if err != nil {
			return err
		}
		in, err := q.LockIntentByID(ctx, op.IntentID)
		if err != nil {
			return err
		}
		v = operationView(op, in.PublicID)
		return nil
	})
	return v, problemOrNil(err)
}

func problemOrNil(err error) error {
	if err == nil {
		return nil
	}
	return problem(err)
}

// ---------------------------------------------------------------------------

func (s *Service) lockScoped(ctx context.Context, q *store.Queries, sc Scope, intentID string) (loaded, error) {
	if _, err := ids.Parse(ids.PaymentIntent, intentID); err != nil {
		return loaded{}, errNotFound
	}
	row, err := q.LockIntentByPublicID(ctx, store.LockIntentByPublicIDParams{PublicID: intentID, MerchantID: sc.MerchantID, Environment: sc.Environment})
	if err != nil {
		return loaded{}, err
	}
	return load(ctx, q, row)
}

// snapshot reads an intent (outside the command transaction) for the
// eligibility request; the amount and currency it reads are immutable.
func (s *Service) snapshot(ctx context.Context, sc Scope, intentID string) (store.PaymentPaymentIntent, error) {
	if _, err := ids.Parse(ids.PaymentIntent, intentID); err != nil {
		return store.PaymentPaymentIntent{}, errNotFound
	}
	var row store.PaymentPaymentIntent
	err := s.inTenant(ctx, sc, func(tx pgx.Tx) error {
		var err error
		row, err = store.New(tx).GetIntentByPublicID(ctx, store.GetIntentByPublicIDParams{PublicID: intentID, MerchantID: sc.MerchantID, Environment: sc.Environment})
		return err
	})
	return row, err
}

func (s *Service) view(ctx context.Context, q *store.Queries, in store.PaymentPaymentIntent) (IntentView, error) {
	var latest *store.PaymentPaymentOperation
	if in.LatestOperationID != nil {
		op, err := q.GetOperation(ctx, *in.LatestOperationID)
		if err != nil {
			return IntentView{}, err
		}
		latest = &op
	}
	return intentView(in, latest), nil
}

// checkReference enforces the merchant_reference policy: bounded, printable,
// and never something that looks like a card number (06-01 PI-004, PI-AT-008).
func checkReference(ref string) string {
	if len(ref) == 0 || len(ref) > 128 {
		return "1 to 128 characters"
	}
	for _, r := range ref {
		if !unicode.IsPrint(r) {
			return "printable characters only"
		}
	}
	if looksLikePAN(ref) {
		return "must not contain a card number"
	}
	return ""
}

// looksLikePAN finds 13–19 digits (spaces or dashes allowed between) that
// pass the Luhn check.
func looksLikePAN(s string) bool {
	var digits []int
	flush := func() bool {
		defer func() { digits = digits[:0] }()
		for start := 0; start < len(digits); start++ {
			for end := start + 13; end <= len(digits) && end-start <= 19; end++ {
				if luhn(digits[start:end]) {
					return true
				}
			}
		}
		return false
	}
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			digits = append(digits, int(r-'0'))
		case r == ' ' || r == '-':
		default:
			if flush() {
				return true
			}
		}
	}
	return flush()
}

func luhn(d []int) bool {
	sum := 0
	for i := len(d) - 1; i >= 0; i-- {
		v := d[i]
		if (len(d)-1-i)%2 == 1 {
			v *= 2
			if v > 9 {
				v -= 9
			}
		}
		sum += v
	}
	return sum%10 == 0
}
