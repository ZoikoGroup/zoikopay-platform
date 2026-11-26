package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/zoiko/zoikopay/internal/platform/trace"
)

// Middleware records one audit entry for every request it wraps, allowed,
// denied or failed (rule 3). It runs inside the trace middleware and outside
// authentication, so it also sees 401s.
//
// The response is held until the entry is recorded. If recording fails, none
// of the handler's response leaves: the caller gets 503 instead, so no access
// goes unrecorded (fail closed, 38.12). environment is the deployment's.
func Middleware(rec Recorder, environment string, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			d := &detail{action: "request"}
			ctx := context.WithValue(r.Context(), ctxKey{}, d)
			buf := &bufferedWriter{header: http.Header{}, status: http.StatusOK}
			next.ServeHTTP(buf, r.WithContext(ctx))

			e := d.entry(trace.ID(ctx), environment, buf.status)
			err := e.Validate()
			if err == nil {
				err = rec.Record(ctx, e)
			}
			if err != nil {
				log.ErrorContext(ctx, "audit entry not recorded; response withheld", "trace_id", e.TraceID, "error", err)
				unavailable(w, e.TraceID)
				return
			}
			buf.flushTo(w)
		})
	}
}

func (d *detail) entry(traceID, environment string, status int) Entry {
	e := Entry{
		TraceID: traceID, Actor: d.actor, Environment: environment, TenantID: d.tenantID,
		Action: d.action, Outcome: OutcomeOf(status), HTTPStatus: status, Reason: d.reason,
	}
	if d.resourceType != "" {
		e.ResourceType, e.ResourceHash = d.resourceType, ResourceHash(d.resourceType, d.resourceID)
	}
	return e
}

// unavailable writes the RFC 9457 503 used when the audit log cannot be
// written. It is built here, not through apierror helpers that would record
// a reason into an entry that can no longer be written.
func unavailable(w http.ResponseWriter, traceID string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Retry-After", "5")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type": "urn:zoikopay:problem:temporarily_unavailable", "title": "Service temporarily unavailable",
		"status": http.StatusServiceUnavailable, "code": "temporarily_unavailable", "retryable": true,
		"detail":     "The service is temporarily unavailable. Retry later and quote the trace ID if it persists.",
		"request_id": traceID, "trace_id": traceID,
	})
}

// bufferedWriter holds a handler's response until the audit entry is recorded.
type bufferedWriter struct {
	header      http.Header
	status      int
	wroteHeader bool
	body        bytes.Buffer
}

func (b *bufferedWriter) Header() http.Header { return b.header }

func (b *bufferedWriter) WriteHeader(code int) {
	if !b.wroteHeader {
		b.status, b.wroteHeader = code, true
	}
}

func (b *bufferedWriter) Write(p []byte) (int, error) {
	b.wroteHeader = true
	return b.body.Write(p)
}

func (b *bufferedWriter) flushTo(w http.ResponseWriter) {
	for k, v := range b.header {
		w.Header()[k] = v
	}
	w.WriteHeader(b.status)
	_, _ = w.Write(b.body.Bytes())
}
