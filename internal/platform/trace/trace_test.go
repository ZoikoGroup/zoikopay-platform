package trace_test

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/zoiko/zoikopay/internal/platform/trace"
)

var traceIDFormat = regexp.MustCompile(`^[0-9a-f]{32}$`)

func serve(t *testing.T, log *slog.Logger, h http.HandlerFunc, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	trace.Middleware(log, h).ServeHTTP(rec, req)
	return rec
}

func newRequest(t *testing.T, method, target string) *http.Request {
	t.Helper()
	return httptest.NewRequestWithContext(t.Context(), method, target, nil)
}

func quiet() *slog.Logger { return slog.New(slog.DiscardHandler) }

// Q37 37.1, 37.2: every response carries a server-generated trace ID, also
// as X-Request-Id, and the handler can read the same ID from the context.
func TestEveryResponseGetsAServerTraceID(t *testing.T) {
	for name, h := range map[string]http.HandlerFunc{
		"writes a body":        func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) },
		"writes only a status": func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) },
		"writes nothing":       func(http.ResponseWriter, *http.Request) {},
	} {
		var seen string
		rec := serve(t, quiet(), func(w http.ResponseWriter, r *http.Request) { seen = trace.ID(r.Context()); h(w, r) },
			newRequest(t, http.MethodGet, "/v1/anything"))
		id := rec.Header().Get(trace.Header)
		if !traceIDFormat.MatchString(id) {
			t.Errorf("%s: X-Trace-Id = %q; want 32 lower-case hex", name, id)
		}
		if got := rec.Header().Get("X-Request-Id"); got != id {
			t.Errorf("%s: X-Request-Id = %q; want the trace ID %q", name, got, id)
		}
		if seen != id {
			t.Errorf("%s: trace.ID in the handler = %q; want %q", name, seen, id)
		}
	}
}

func TestTraceIDsAreUniquePerRequest(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		id := serve(t, quiet(), func(http.ResponseWriter, *http.Request) {}, newRequest(t, http.MethodGet, "/")).Header().Get(trace.Header)
		if seen[id] {
			t.Fatalf("trace ID %s issued twice", id)
		}
		seen[id] = true
	}
}

// 04-01: a client hint is untrusted data; traceparent is not identity.
func TestClientTraceHintsAreNeverTrustedOrEchoed(t *testing.T) {
	const forged = "0123456789abcdef0123456789abcdef"
	req := newRequest(t, http.MethodGet, "/v1/merchants")
	req.Header.Set("X-Trace-Id", forged)
	req.Header.Set("X-Request-Id", forged)
	req.Header.Set("Traceparent", "00-"+forged+"-0123456789abcdef-01")
	var seen string
	rec := serve(t, quiet(), func(_ http.ResponseWriter, r *http.Request) { seen = trace.ID(r.Context()) }, req)
	for _, got := range []string{rec.Header().Get(trace.Header), rec.Header().Get("X-Request-Id"), seen} {
		if got == forged || got == "" {
			t.Errorf("trace ID %q: the client's value was used or none was issued", got)
		}
	}
}

func TestIDOutsideARequestIsEmpty(t *testing.T) {
	if id := trace.ID(t.Context()); id != "" {
		t.Errorf("trace.ID without the middleware = %q; want empty", id)
	}
}

// Q37 37.13: one access line per request with safe fields only.
func TestAccessLogHasNoSecrets(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	const token = "eyJhbGciOiJSUzI1NiJ9.secret-token-payload.secret-token-signature" //nolint:gosec // G101: fake token, used to prove it never reaches the log.
	req := newRequest(t, http.MethodGet, "/v1/merchants/mer_x?access_token=secret-query-token&tenant_id=ten_x")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Cookie", "zp_console_sid=secret-cookie")
	rec := serve(t, log, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) }, req)

	out := buf.String()
	for _, secret := range []string{token, "secret-token", "secret-query-token", "secret-cookie", "Bearer", "access_token", "Authorization", "Cookie"} {
		if strings.Contains(out, secret) {
			t.Errorf("access log contains %q:\n%s", secret, out)
		}
	}
	for _, want := range []string{rec.Header().Get(trace.Header), `"method":"GET"`, `"path":"/v1/merchants/mer_x"`, `"status":418`} {
		if !strings.Contains(out, want) {
			t.Errorf("access log lacks %s:\n%s", want, out)
		}
	}
}
