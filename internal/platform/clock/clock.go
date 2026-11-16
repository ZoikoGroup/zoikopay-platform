// Package clock provides an injectable UTC clock so domain logic and tests
// never call time.Now directly.
package clock

import (
	"sync"
	"time"
)

// Clock returns the current time. Implementations always return UTC
// (spec 02-05: all timestamps are UTC).
type Clock interface {
	Now() time.Time
}

// System is the real wall clock.
type System struct{}

// Now returns the current UTC time.
func (System) Now() time.Time { return time.Now().UTC() }

// Fake is a manually controlled clock for tests. The zero value starts at the
// Unix epoch. It is safe for concurrent use.
type Fake struct {
	mu  sync.Mutex
	now time.Time
}

// NewFake returns a Fake set to t (converted to UTC).
func NewFake(t time.Time) *Fake { return &Fake{now: t.UTC()} }

// Now returns the fake's current time.
func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.now.IsZero() {
		return time.Unix(0, 0).UTC()
	}
	return f.now
}

// Set moves the clock to t.
func (f *Fake) Set(t time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = t.UTC()
}

// Advance moves the clock forward by d.
func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.now.IsZero() {
		f.now = time.Unix(0, 0).UTC()
	}
	f.now = f.now.Add(d)
}
