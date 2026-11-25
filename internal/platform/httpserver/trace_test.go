package httpserver_test

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"

	"github.com/zoiko/zoikopay/internal/platform/httpserver"
)

// Q37 37.1: every response of every deployable, health included, carries X-Trace-Id.
func TestEveryRouteResponseCarriesATraceID(t *testing.T) {
	s := httpserver.New(httpserver.Config{Name: "test"}, slog.New(slog.DiscardHandler))
	s.Mux().HandleFunc("GET /v1/thing", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	format := regexp.MustCompile(`^[0-9a-f]{32}$`)
	for _, path := range []string{"/livez", "/readyz", "/healthz", "/v1/thing", "/no/such/route"} {
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
		if id := rec.Header().Get("X-Trace-Id"); !format.MatchString(id) {
			t.Errorf("%s: X-Trace-Id = %q; want a server trace ID", path, id)
		}
	}
}
