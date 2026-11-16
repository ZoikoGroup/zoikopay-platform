// Package bootstrap holds the shared start-up wiring for every ZoikoPay
// binary: structured logging, signal handling, dependency connection with
// retry, the HTTP listener and orderly shutdown.
package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"slices"
	"syscall"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/health"
	"github.com/zoiko/zoikopay/internal/platform/httpserver"
)

// Service describes one deployable binary.
type Service struct {
	// Name is the stable service name used in logs and traces.
	Name string
	// DefaultAddr is used when ZP_HTTP_ADDR is not set.
	DefaultAddr string
	// Dependencies are connected, in order, before the listener starts.
	// Built from the logger so dependency clients can log through it.
	Dependencies func(log *slog.Logger) []health.Dependency
	// Register mounts the binary's routes. It may be nil.
	Register func(s *httpserver.Server, log *slog.Logger) error
}

// Main runs the service and exits the process with a non-zero code on error.
func Main(svc Service) {
	log := NewLogger(svc.Name)
	if err := run(svc, log); err != nil {
		log.Error("service stopped with error", "error", err)
		os.Exit(1)
	}
	log.Info("service stopped")
}

func run(svc Service, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	timeout, err := envDuration("ZP_STARTUP_TIMEOUT", 60*time.Second)
	if err != nil {
		return err
	}

	var deps []health.Dependency
	if svc.Dependencies != nil {
		deps = svc.Dependencies(log)
	}
	checks, closers, err := connectAll(ctx, log, deps, timeout)
	defer func() {
		for _, c := range slices.Backward(closers) {
			c()
		}
	}()
	if err != nil {
		return err
	}

	addr := os.Getenv("ZP_HTTP_ADDR")
	if addr == "" {
		addr = svc.DefaultAddr
	}
	srv := httpserver.New(httpserver.Config{Name: svc.Name, Addr: addr, Checks: checks}, log)
	if svc.Register != nil {
		if err := svc.Register(srv, log); err != nil {
			return fmt.Errorf("register routes: %w", err)
		}
	}
	return srv.Run(ctx)
}

// connectAll opens each dependency, retrying transient failures until timeout.
// Closers for dependencies already opened are returned even on error.
func connectAll(ctx context.Context, log *slog.Logger, deps []health.Dependency, timeout time.Duration) ([]health.Check, []func(), error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var checks []health.Check
	var closers []func()
	for _, d := range deps {
		probe, closeFn, err := connect(ctx, log, d)
		if err != nil {
			return checks, closers, fmt.Errorf("connect %s: %w", d.Name, err)
		}
		closers = append(closers, closeFn)
		checks = append(checks, health.Check{Name: d.Name, Probe: probe})
		log.Info("dependency connected", "dependency", d.Name)
	}
	return checks, closers, nil
}

func connect(ctx context.Context, log *slog.Logger, d health.Dependency) (health.Probe, func(), error) {
	delay := 500 * time.Millisecond
	for attempt := 1; ; attempt++ {
		probe, closeFn, err := d.Open(ctx)
		if err == nil {
			return probe, closeFn, nil
		}
		if errors.Is(err, health.ErrConfig) {
			return nil, nil, err
		}
		log.Warn("dependency not reachable yet", "dependency", d.Name, "attempt", attempt, "error", err)
		select {
		case <-ctx.Done():
			return nil, nil, fmt.Errorf("gave up after %d attempts: %w", attempt, err)
		case <-time.After(delay):
		}
		delay = min(delay*2, 5*time.Second)
	}
}

func envDuration(name string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(name)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("%w: %s=%q is not a positive duration", health.ErrConfig, name, v)
	}
	return d, nil
}

// NewLogger returns a JSON logger tagged with the service name.
// ZP_LOG_LEVEL accepts debug, info, warn or error (default info).
func NewLogger(service string) *slog.Logger {
	var level slog.Level
	if err := level.UnmarshalText([]byte(os.Getenv("ZP_LOG_LEVEL"))); err != nil {
		level = slog.LevelInfo
	}
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	return slog.New(h).With("service", service)
}
