package http

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	stdhttp "net/http"
	"strconv"
	"strings"
	"time"

	"github.com/zoiko/zoikopay/internal/apigen/executionapi"
	"github.com/zoiko/zoikopay/internal/payment/app"
	"github.com/zoiko/zoikopay/internal/platform/apierror"
	"github.com/zoiko/zoikopay/internal/platform/idempotency"
	"github.com/zoiko/zoikopay/internal/platform/ids"
	"github.com/zoiko/zoikopay/internal/platform/money"
)

// Authenticator resolves the server-side scope of a request from the
// verified caller identity and claims (06-01 §6.1 steps 1–3, 03-03 §4
// "A caller identity plus tenant/merchant/legal-cell claim required"). It must
// never read scope from the body. The concrete D1→D2 service authentication
// is not built yet (M4); until then this handler is not mounted in
// cmd/execution (ADR 0006 §7).
type Authenticator interface {
	Authenticate(r *stdhttp.Request) (app.Scope, error)
}

// Handler serves the private payment command API (api/openapi/execution.v1.yaml).
type Handler struct {
	Svc  *app.Service
	Auth Authenticator
	IDs  ids.Generator
}

var _ executionapi.ServerInterface = (*Handler)(nil)

// Routes returns the generated router with problem+json errors for bad parameters.
func (h *Handler) Routes() stdhttp.Handler {
	mux := stdhttp.NewServeMux()
	return executionapi.HandlerWithOptions(h, executionapi.StdHTTPServerOptions{
		BaseRouter: mux,
		ErrorHandlerFunc: func(w stdhttp.ResponseWriter, r *stdhttp.Request, err error) {
			var missing *executionapi.RequiredHeaderError
			if errors.As(err, &missing) && strings.EqualFold(missing.ParamName, idempotency.Header) {
				// 04-01 §8: idempotency_key_required is a 400.
				apierror.Write(w, h.requestID(r), apierror.New(apierror.IdempotencyKeyRequired, idempotency.ErrKeyMissing.Error()))
				return
			}
			apierror.Write(w, h.requestID(r), apierror.Validation("A request parameter is not valid.",
				apierror.FieldError{Field: "parameters", Reason: err.Error()}))
		},
	})
}

const maxBody = 16 << 10

func (h *Handler) requestID(r *stdhttp.Request) string {
	if id := r.Header.Get(apierror.RequestIDHeader); id != "" && len(id) <= 128 {
		return id
	}
	return "req_" + h.IDs.NewInternal()
}

// scope authenticates; any failure is 401 without detail.
func (h *Handler) scope(w stdhttp.ResponseWriter, r *stdhttp.Request) (app.Scope, string, bool) {
	rid := h.requestID(r)
	if h.Auth == nil {
		apierror.Write(w, rid, apierror.New(apierror.AuthenticationRequired, "Authentication is required."))
		return app.Scope{}, rid, false
	}
	sc, err := h.Auth.Authenticate(r)
	if err != nil {
		apierror.Write(w, rid, apierror.New(apierror.AuthenticationRequired, "Authentication is required."))
		return app.Scope{}, rid, false
	}
	sc.RequestID = rid
	if sc.CorrelationID == "" {
		sc.CorrelationID = rid
	}
	return sc, rid, true
}

func key(w stdhttp.ResponseWriter, r *stdhttp.Request, rid string) (idempotency.Key, bool) {
	k, err := idempotency.ParseHeader(r.Header.Values(idempotency.Header))
	if err != nil {
		apierror.Write(w, rid, apierror.New(apierror.IdempotencyKeyRequired, err.Error()))
		return "", false
	}
	return k, true
}

// decode reads a JSON body strictly: unknown fields, trailing data, numbers
// for money and oversize bodies are rejected (04-02 §5.2 additionalProperties:false).
func decode(w stdhttp.ResponseWriter, r *stdhttp.Request, rid string, v any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBody+1))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		apierror.Write(w, rid, apierror.Validation("The request body is not valid.", apierror.FieldError{Field: "body", Reason: safeJSONError(err)}))
		return false
	}
	if dec.More() {
		apierror.Write(w, rid, apierror.Validation("The request body is not valid.", apierror.FieldError{Field: "body", Reason: "trailing data"}))
		return false
	}
	return true
}

func safeJSONError(err error) string {
	var syn *json.SyntaxError
	var typ *json.UnmarshalTypeError
	switch {
	case errors.As(err, &syn):
		return "malformed JSON"
	case errors.As(err, &typ):
		return "wrong type for " + typ.Field
	case errors.Is(err, money.ErrFormat), errors.Is(err, money.ErrRange):
		return err.Error()
	case errors.Is(err, io.EOF):
		return "empty body"
	}
	return err.Error()
}

func write(w stdhttp.ResponseWriter, rid string, status int, location string, v any) {
	w.Header().Set(apierror.RequestIDHeader, rid)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if location != "" {
		w.Header().Set("Location", location)
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w stdhttp.ResponseWriter, rid string, err error) {
	apierror.WriteError(w, rid, err)
}

func respond(w stdhttp.ResponseWriter, rid string, res app.Result) {
	if res.Op != nil {
		write(w, rid, res.Status, "/v1/operations/"+res.Op.ID, res.Op)
		return
	}
	loc := ""
	if res.Status == stdhttp.StatusCreated {
		loc = "/v1/payment_intents/" + res.Intent.ID
	}
	write(w, rid, res.Status, loc, res.Intent)
}

func ctx(r *stdhttp.Request) context.Context { return r.Context() }

// ---------------------------------------------------------------------------

type createBody struct {
	Amount             money.Minor `json:"amount_minor"`
	Currency           string      `json:"currency"`
	CaptureMethod      string      `json:"capture_method"`
	PaymentMethodToken string      `json:"payment_method_token"`
	MerchantReference  *string     `json:"merchant_reference"`
	ExpiresAt          *time.Time  `json:"expires_at"`
}

// CreatePaymentIntent handles POST /v1/payment_intents.
func (h *Handler) CreatePaymentIntent(w stdhttp.ResponseWriter, r *stdhttp.Request, _ executionapi.CreatePaymentIntentParams) {
	sc, rid, ok := h.scope(w, r)
	if !ok {
		return
	}
	k, ok := key(w, r, rid)
	if !ok {
		return
	}
	var b createBody
	if !decode(w, r, rid, &b) {
		return
	}
	res, err := h.Svc.CreateIntent(ctx(r), sc, k, app.CreateRequest{Amount: b.Amount, Currency: b.Currency,
		CaptureMethod: b.CaptureMethod, PaymentMethodToken: b.PaymentMethodToken, MerchantReference: b.MerchantReference, ExpiresAt: b.ExpiresAt})
	if err != nil {
		fail(w, rid, err)
		return
	}
	respond(w, rid, res)
}

type confirmBody struct {
	PaymentMethodToken *string `json:"payment_method_token"`
	ExpectedRevision   int64   `json:"expected_revision"`
}

// ConfirmPaymentIntent handles POST .../confirm.
func (h *Handler) ConfirmPaymentIntent(w stdhttp.ResponseWriter, r *stdhttp.Request, id executionapi.PaymentIntentId, _ executionapi.ConfirmPaymentIntentParams) {
	sc, rid, ok := h.scope(w, r)
	if !ok {
		return
	}
	k, ok := key(w, r, rid)
	if !ok {
		return
	}
	var b confirmBody
	if !decode(w, r, rid, &b) {
		return
	}
	res, err := h.Svc.ConfirmIntent(ctx(r), sc, k, id, app.ConfirmRequest{PaymentMethodToken: b.PaymentMethodToken, ExpectedRevision: b.ExpectedRevision})
	if err != nil {
		fail(w, rid, err)
		return
	}
	respond(w, rid, res)
}

type captureBody struct {
	Amount           money.Minor `json:"amount_minor"`
	ExpectedRevision int64       `json:"expected_revision"`
}

// CapturePaymentIntent handles POST .../capture.
func (h *Handler) CapturePaymentIntent(w stdhttp.ResponseWriter, r *stdhttp.Request, id executionapi.PaymentIntentId, _ executionapi.CapturePaymentIntentParams) {
	sc, rid, ok := h.scope(w, r)
	if !ok {
		return
	}
	k, ok := key(w, r, rid)
	if !ok {
		return
	}
	var b captureBody
	if !decode(w, r, rid, &b) {
		return
	}
	res, err := h.Svc.CaptureIntent(ctx(r), sc, k, id, app.CaptureRequest{Amount: b.Amount, ExpectedRevision: b.ExpectedRevision})
	if err != nil {
		fail(w, rid, err)
		return
	}
	respond(w, rid, res)
}

type cancelBody struct {
	ExpectedRevision int64 `json:"expected_revision"`
}

// CancelPaymentIntent handles POST .../cancel.
func (h *Handler) CancelPaymentIntent(w stdhttp.ResponseWriter, r *stdhttp.Request, id executionapi.PaymentIntentId, _ executionapi.CancelPaymentIntentParams) {
	sc, rid, ok := h.scope(w, r)
	if !ok {
		return
	}
	k, ok := key(w, r, rid)
	if !ok {
		return
	}
	var b cancelBody
	if !decode(w, r, rid, &b) {
		return
	}
	res, err := h.Svc.CancelIntent(ctx(r), sc, k, id, app.CancelRequest{ExpectedRevision: b.ExpectedRevision})
	if err != nil {
		fail(w, rid, err)
		return
	}
	respond(w, rid, res)
}

// GetPaymentIntent handles GET /v1/payment_intents/{id}.
func (h *Handler) GetPaymentIntent(w stdhttp.ResponseWriter, r *stdhttp.Request, id executionapi.PaymentIntentId) {
	sc, rid, ok := h.scope(w, r)
	if !ok {
		return
	}
	v, err := h.Svc.GetIntent(ctx(r), sc, id)
	if err != nil {
		fail(w, rid, err)
		return
	}
	write(w, rid, stdhttp.StatusOK, "", v)
}

// ListPaymentIntents handles GET /v1/payment_intents.
func (h *Handler) ListPaymentIntents(w stdhttp.ResponseWriter, r *stdhttp.Request, p executionapi.ListPaymentIntentsParams) {
	sc, rid, ok := h.scope(w, r)
	if !ok {
		return
	}
	cursor, limit := "", app.MaxPageSize
	if p.Cursor != nil {
		cursor = *p.Cursor
	}
	if p.Limit != nil {
		if *p.Limit < 1 || *p.Limit > app.MaxPageSize {
			apierror.Write(w, rid, apierror.Validation("limit is not valid.", apierror.FieldError{Field: "limit", Reason: "1 to " + strconv.Itoa(app.MaxPageSize)}))
			return
		}
		limit = *p.Limit
	}
	page, err := h.Svc.ListIntents(ctx(r), sc, cursor, limit)
	if err != nil {
		fail(w, rid, err)
		return
	}
	write(w, rid, stdhttp.StatusOK, "", page)
}

// GetOperation handles GET /v1/operations/{id}.
func (h *Handler) GetOperation(w stdhttp.ResponseWriter, r *stdhttp.Request, id string) {
	sc, rid, ok := h.scope(w, r)
	if !ok {
		return
	}
	if _, err := ids.Parse(ids.Operation, id); err != nil {
		fail(w, rid, apierror.New(apierror.ResourceNotFound, "No such payment resource."))
		return
	}
	v, err := h.Svc.GetOperation(ctx(r), sc, id)
	if err != nil {
		fail(w, rid, err)
		return
	}
	write(w, rid, stdhttp.StatusOK, "", v)
}
