// Package health defines the dependency and health-check types every
// deployable shares. A Dependency is opened once at start-up and then probed
// by /healthz and /readyz.
package health

import (
	"context"
	"errors"
)

// Probe reports whether a dependency is healthy. A nil error means healthy.
type Probe func(ctx context.Context) error

// Check is a named probe, reported individually on /healthz.
type Check struct {
	Name  string
	Probe Probe
}

// Dependency is an external system a deployable needs before it can serve.
type Dependency struct {
	// Name appears in logs and in the /healthz response ("postgres", "temporal").
	Name string
	// Open connects to the dependency. It returns the probe used afterwards and
	// a function that releases the connection on shutdown (never nil on success).
	// Errors wrapping ErrConfig are not retried.
	Open func(ctx context.Context) (Probe, func(), error)
}

// ErrConfig marks a configuration error (for example a missing environment
// variable). Start-up fails immediately instead of retrying.
var ErrConfig = errors.New("configuration error")
