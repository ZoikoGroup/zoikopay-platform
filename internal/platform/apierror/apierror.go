package apierror

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
)

// Code is a stable, documented problem code (04-01 §8). Clients act on the
// code, never on the human-readable title or detail.
type Code string

// Problem codes from the 04-01 §8 registry, with their HTTP status.
const (
	AuthenticationRequired         Code = "authentication_required"
	PermissionDenied               Code = "permission_denied"
	ResourceNotFound               Code = "resource_not_found"
	ValidationError                Code = "validation_error"
	IdempotencyKeyRequired         Code = "idempotency_key_required"
	IdempotencyFingerprintMismatch Code = "idempotency_fingerprint_mismatch"
	OperationInProgress            Code = "operation_in_progress"
	OperationStateConflict         Code = "operation_state_conflict"
	CapabilityNotAvailable         Code = "capability_not_available"
	RateLimitExceeded              Code = "rate_limit_exceeded"
	ProviderOutcomeUnknown         Code = "provider_outcome_unknown"
	TemporarilyUnavailable         Code = "temporarily_unavailable"
	// InternalError is not in the 04-01 table; it is the safe fallback for
	// unexpected failures and never carries internal detail.
	InternalError Code = "internal_error"
)

type codeInfo struct {
	status    int
	title     string
	retryable bool
}

var codes = map[Code]codeInfo{
	AuthenticationRequired:         {http.StatusUnauthorized, "Authentication required", false},
	PermissionDenied:               {http.StatusForbidden, "Permission denied", false},
	ResourceNotFound:               {http.StatusNotFound, "Resource not found", false},
	ValidationError:                {http.StatusUnprocessableEntity, "Request is not valid", false},
	IdempotencyKeyRequired:         {http.StatusBadRequest, "Idempotency-Key header is required", false},
	IdempotencyFingerprintMismatch: {http.StatusUnprocessableEntity, "Idempotency-Key was used with a different request", false},
	OperationInProgress:            {http.StatusConflict, "Operation is still processing", false},
	OperationStateConflict:         {http.StatusConflict, "Operation is not allowed in the current state", false},
	CapabilityNotAvailable:         {http.StatusForbidden, "Capability is not available", false},
	RateLimitExceeded:              {http.StatusTooManyRequests, "Too many requests", true},
	ProviderOutcomeUnknown:         {http.StatusConflict, "Provider outcome is not yet known", false},
	TemporarilyUnavailable:         {http.StatusServiceUnavailable, "Service temporarily unavailable", true},
	InternalError:                  {http.StatusInternalServerError, "Internal error", false},
}

// TypeURI returns the problem type for a code. 04-01 says documentation hosts
// are illustrative until the domain is approved, so the type is a URN that
// makes no claim about a live URL.
func TypeURI(c Code) string { return "urn:zoikopay:problem:" + string(c) }

// FieldError is one typed validation failure.
type FieldError struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

// Problem is an RFC 9457 problem details body with Zoiko extensions.
type Problem struct {
	Type        string       `json:"type"`
	Title       string       `json:"title"`
	Status      int          `json:"status"`
	Detail      string       `json:"detail,omitempty"`
	Instance    string       `json:"instance,omitempty"`
	Code        Code         `json:"code"`
	RequestID   string       `json:"request_id,omitempty"`
	TraceID     string       `json:"trace_id,omitempty"` // OPEN_QUESTIONS Q37 37.1
	OperationID string       `json:"operation_id,omitempty"`
	Retryable   bool         `json:"retryable"`
	Errors      []FieldError `json:"errors,omitempty"`
}

// Error lets a *Problem travel as an error through handlers.
func (p *Problem) Error() string { return string(p.Code) + ": " + p.Detail }

// New builds a problem for code with a human-readable detail. Detail must not
// contain card data, personal data or another tenant's identifiers (04-01).
func New(code Code, detail string) *Problem {
	info, ok := codes[code]
	if !ok {
		code, info = InternalError, codes[InternalError]
	}
	return &Problem{Type: TypeURI(code), Title: info.title, Status: info.status, Detail: detail, Code: code, Retryable: info.retryable}
}

// Validation returns a validation_error with field errors.
func Validation(detail string, fields ...FieldError) *Problem {
	p := New(ValidationError, detail)
	p.Errors = fields
	return p
}

// WithOperation attaches the operation the client should query.
func (p *Problem) WithOperation(id string) *Problem {
	p.OperationID = id
	return p
}

// Status returns the HTTP status registered for code (500 if unknown).
func Status(code Code) int {
	if info, ok := codes[code]; ok {
		return info.status
	}
	return http.StatusInternalServerError
}

// RequestIDHeader carries the request ID on every response (04-01).
const RequestIDHeader = "X-Request-Id"

// Write sends p as application/problem+json. requestID is echoed in the body
// and the X-Request-Id header.
func Write(w http.ResponseWriter, requestID string, p *Problem) {
	p.RequestID = requestID
	if requestID != "" {
		w.Header().Set(RequestIDHeader, requestID)
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(p.Status)
	if err := json.NewEncoder(w).Encode(p); err != nil {
		slog.Warn("write problem response", "error", err)
	}
}

// WriteError sends err as a problem. A *Problem is sent as is; anything else
// becomes internal_error without leaking its message, and is logged.
func WriteError(w http.ResponseWriter, requestID string, err error) {
	var p *Problem
	if errors.As(err, &p) {
		Write(w, requestID, p)
		return
	}
	slog.Error("unhandled error", "request_id", requestID, "error", err)
	Write(w, requestID, New(InternalError, "An unexpected error occurred. Quote the request ID when contacting support."))
}
