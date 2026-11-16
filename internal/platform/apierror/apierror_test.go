package apierror_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zoiko/zoikopay/internal/platform/apierror"
)

func TestStatusesMatch0401Registry(t *testing.T) {
	want := map[apierror.Code]int{
		apierror.AuthenticationRequired: 401, apierror.PermissionDenied: 403, apierror.ResourceNotFound: 404,
		apierror.ValidationError: 422, apierror.IdempotencyKeyRequired: 400, apierror.IdempotencyFingerprintMismatch: 422,
		apierror.OperationInProgress: 409, apierror.OperationStateConflict: 409, apierror.RateLimitExceeded: 429,
		apierror.TemporarilyUnavailable: 503,
	}
	for c, s := range want {
		if got := apierror.Status(c); got != s {
			t.Errorf("%s status = %d; want %d", c, got, s)
		}
	}
}

func TestWriteProducesProblemJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	apierror.Write(rec, "req_123", apierror.New(apierror.OperationInProgress, "Check the existing operation before retrying.").WithOperation("op_1"))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("content type = %q", ct)
	}
	if rec.Header().Get("X-Request-Id") != "req_123" {
		t.Fatal("X-Request-Id not echoed")
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for k, v := range map[string]any{"type": "urn:zoikopay:problem:operation_in_progress", "status": float64(409),
		"code": "operation_in_progress", "request_id": "req_123", "operation_id": "op_1", "retryable": false} {
		if body[k] != v {
			t.Errorf("%s = %v; want %v", k, body[k], v)
		}
	}
}

func TestUnexpectedErrorsDoNotLeak(t *testing.T) {
	rec := httptest.NewRecorder()
	apierror.WriteError(rec, "req_9", errors.New("pq: password authentication failed for user zp_gateway"))
	if rec.Code != 500 || strings.Contains(rec.Body.String(), "zp_gateway") {
		t.Fatalf("internal error leaked: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	apierror.WriteError(rec, "req_9", apierror.Validation("amount_minor is invalid", apierror.FieldError{Field: "amount_minor", Reason: "must be a decimal string"}))
	if rec.Code != 422 || !strings.Contains(rec.Body.String(), `"field":"amount_minor"`) {
		t.Fatalf("validation problem: %d %s", rec.Code, rec.Body.String())
	}
}
