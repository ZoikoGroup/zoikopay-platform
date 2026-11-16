package clock_test

import (
	"testing"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/clock"
)

func TestSystemIsUTC(t *testing.T) {
	if loc := (clock.System{}).Now().Location(); loc != time.UTC {
		t.Fatalf("location = %v", loc)
	}
}

func TestFake(t *testing.T) {
	start := time.Date(2026, 11, 16, 12, 0, 0, 0, time.FixedZone("X", 3600))
	f := clock.NewFake(start)
	if !f.Now().Equal(start) || f.Now().Location() != time.UTC {
		t.Fatal("NewFake should keep the instant and convert to UTC")
	}
	f.Advance(90 * time.Second)
	if got := f.Now().Sub(start); got != 90*time.Second {
		t.Fatalf("advanced %v", got)
	}
	var zero clock.Fake
	if !zero.Now().Equal(time.Unix(0, 0)) {
		t.Fatal("zero Fake starts at the epoch")
	}
}
