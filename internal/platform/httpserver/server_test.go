package httpserver_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/health"
	"github.com/zoiko/zoikopay/internal/platform/httpserver"
)

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

var (
	ok  = health.Check{Name: "postgres", Probe: func(context.Context) error { return nil }}
	bad = health.Check{Name: "temporal", Probe: func(context.Context) error { return errors.New("down: secret-host:7233") }}
)

func get(t *testing.T, s *httpserver.Server, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
	return rec
}

func TestLivezIgnoresDependencies(t *testing.T) {
	s := httpserver.New(httpserver.Config{Name: "t", Checks: []health.Check{bad}}, discardLogger())
	if rec := get(t, s, "/livez"); rec.Code != http.StatusOK {
		t.Fatalf("livez = %d, want 200", rec.Code)
	}
}

func TestReadyzAndHealthzFailClosed(t *testing.T) {
	tests := []struct {
		name   string
		checks []health.Check
		want   int
	}{
		{"no checks", nil, http.StatusOK},
		{"all pass", []health.Check{ok}, http.StatusOK},
		{"one fails", []health.Check{ok, bad}, http.StatusServiceUnavailable},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := httpserver.New(httpserver.Config{Name: "t", Checks: tc.checks}, discardLogger())
			for _, path := range []string{"/readyz", "/healthz"} {
				if rec := get(t, s, path); rec.Code != tc.want {
					t.Fatalf("%s = %d, want %d", path, rec.Code, tc.want)
				}
			}
		})
	}
}

func TestHealthzReportsEachCheckWithoutErrorDetail(t *testing.T) {
	s := httpserver.New(httpserver.Config{Name: "execution", Checks: []health.Check{ok, bad}}, discardLogger())
	rec := get(t, s, "/healthz")

	var got httpserver.HealthReport
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	if got.Service != "execution" || got.Status != "degraded" ||
		got.Checks["postgres"] != "ok" || got.Checks["temporal"] != "error" {
		t.Fatalf("unexpected report %+v", got)
	}
	if strings.Contains(rec.Body.String(), "secret-host") {
		t.Fatalf("healthz leaked error detail: %s", rec.Body.String())
	}
}

func TestServeShutsDownOnContextCancel(t *testing.T) {
	var lc net.ListenConfig
	ln, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := httpserver.New(httpserver.Config{Name: "t", ShutdownTimeout: time.Second}, discardLogger())
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, ln) }()

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+ln.Addr().String()+"/healthz", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz = %d, want 200", resp.StatusCode)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not shut down")
	}
}
