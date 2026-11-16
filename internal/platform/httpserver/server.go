// Package httpserver runs a binary's HTTP listener with health endpoints and
// graceful shutdown. It is deliberately small: every deployable uses it so
// health behaves identically everywhere.
//
//	/livez    the process is running (no dependency checks).
//	/readyz   every dependency is reachable; plain text for load balancers.
//	/healthz  the same checks as /readyz, reported per dependency as JSON.
//
// Health never implies permission to move money (spec 03-03 §9.3);
// safe-to-dispatch signals are separate and are added by the modules that own them.
package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/health"
)

// Config holds the listener settings for one binary.
type Config struct {
	Name            string
	Addr            string
	ShutdownTimeout time.Duration
	Checks          []health.Check
}

// Server wraps net/http with health endpoints and lifecycle handling.
type Server struct {
	cfg      Config
	log      *slog.Logger
	mux      *http.ServeMux
	draining atomic.Bool
}

// New builds a server. Callers register their own routes on Mux().
func New(cfg Config, log *slog.Logger) *Server {
	if cfg.ShutdownTimeout == 0 {
		cfg.ShutdownTimeout = 15 * time.Second
	}
	s := &Server{cfg: cfg, log: log, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /livez", s.livez)
	s.mux.HandleFunc("GET /readyz", s.readyz)
	s.mux.HandleFunc("GET /healthz", s.healthz)
	return s
}

// Mux returns the router so binaries can mount their handlers.
func (s *Server) Mux() *http.ServeMux { return s.mux }

// Handler exposes the full handler, mainly for tests.
func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) livez(w http.ResponseWriter, _ *http.Request) {
	writeText(w, http.StatusOK, "ok")
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		writeText(w, http.StatusServiceUnavailable, "draining")
		return
	}
	if _, ok := s.runChecks(r.Context()); !ok {
		writeText(w, http.StatusServiceUnavailable, "not ready")
		return
	}
	writeText(w, http.StatusOK, "ready")
}

// HealthReport is the JSON body of /healthz.
type HealthReport struct {
	Service string            `json:"service"`
	Status  string            `json:"status"` // "ok", "degraded" or "draining"
	Checks  map[string]string `json:"checks"` // dependency name → "ok" or "error"
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	results, ok := s.runChecks(r.Context())
	report := HealthReport{Service: s.cfg.Name, Status: "ok", Checks: results}
	code := http.StatusOK
	switch {
	case s.draining.Load():
		report.Status, code = "draining", http.StatusServiceUnavailable
	case !ok:
		report.Status, code = "degraded", http.StatusServiceUnavailable
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(report)
}

// runChecks probes every dependency concurrently. Error details go to the log
// only, so health responses never expose connection strings or hosts.
func (s *Server) runChecks(parent context.Context) (map[string]string, bool) {
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()

	results := make(map[string]string, len(s.cfg.Checks))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, c := range s.cfg.Checks {
		wg.Go(func() {
			status := "ok"
			if err := c.Probe(ctx); err != nil {
				status = "error"
				s.log.WarnContext(ctx, "health check failed", "check", c.Name, "error", err)
			}
			mu.Lock()
			results[c.Name] = status
			mu.Unlock()
		})
	}
	wg.Wait()
	for _, v := range results {
		if v != "ok" {
			return results, false
		}
	}
	return results, true
}

func writeText(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_, _ = fmt.Fprintln(w, msg)
}

// Run serves until ctx is canceled, then drains and shuts down.
func (s *Server) Run(ctx context.Context) error {
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", s.cfg.Addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", s.cfg.Addr, err)
	}
	return s.Serve(ctx, ln)
}

// Serve is Run with a caller-supplied listener (used by tests).
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	srv := &http.Server{
		Handler:           s.mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return context.WithoutCancel(ctx) },
	}

	errCh := make(chan error, 1)
	go func() {
		s.log.Info("http server listening", "addr", ln.Addr().String())
		errCh <- srv.Serve(ln)
	}()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}

	s.draining.Store(true)
	s.log.Info("http server draining")
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-errCh; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
