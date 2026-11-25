// Package trace gives every HTTP request a server-generated trace ID and
// writes one access-log line per request (OPEN_QUESTIONS Q37, 37.1, 37.2, 37.13).
package trace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"
)

// Header carries the trace ID on every response.
const Header = "X-Trace-Id"

// requestIDHeader is 04-01's X-Request-Id; it carries the same value (37.2).
const requestIDHeader = "X-Request-Id"

type ctxKey struct{}

// ID returns the request's trace ID, or "" outside a traced request.
func ID(ctx context.Context) string {
	id, _ := ctx.Value(ctxKey{}).(string)
	return id
}

// newID returns 16 random bytes as 32 lower-case hex digits (the W3C trace-id
// format). crypto/rand does not fail on supported platforms.
func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Middleware assigns a fresh trace ID before next runs, sets it as X-Trace-Id
// and X-Request-Id on the response, and logs the request. Client-supplied
// X-Trace-Id, X-Request-Id and traceparent are ignored: 04-01 treats a client
// hint as untrusted data and traceparent as never being identity.
//
// The log line holds the trace ID, method, path without query, status and
// duration only: never headers (Authorization, Cookie), the query string or
// the body, so tokens and secrets cannot reach it.
func Middleware(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := newID()
		w.Header().Set(Header, id)
		w.Header().Set(requestIDHeader, id)
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		ctx := context.WithValue(r.Context(), ctxKey{}, id)
		next.ServeHTTP(sw, r.WithContext(ctx))

		level := slog.LevelInfo
		switch r.URL.Path {
		case "/livez", "/readyz", "/healthz":
			level = slog.LevelDebug // probes run every few seconds
		}
		log.LogAttrs(ctx, level, "http request",
			slog.String("trace_id", id),
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", sw.status),
			slog.Duration("duration", time.Since(start)),
		)
	})
}

// statusWriter records the status code for the access log.
type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusWriter) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status, s.wroteHeader = code, true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	s.wroteHeader = true
	return s.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }
