package ids_test

import (
	"errors"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/ids"
)

func TestNewHasPrefixAndParses(t *testing.T) {
	for _, p := range []ids.Prefix{ids.PaymentIntent, ids.Operation, ids.Refund, ids.Merchant, ids.Tenant} {
		id := ids.New(p)
		if !strings.HasPrefix(id, string(p)) || len(id) != len(p)+32 {
			t.Fatalf("New(%s) = %q", p, id)
		}
		if _, err := ids.Parse(p, id); err != nil {
			t.Fatalf("Parse(%s, %s): %v", p, id, err)
		}
	}
}

func TestIDsSortByCreationTime(t *testing.T) {
	base := time.Date(2026, 11, 16, 9, 0, 0, 0, time.UTC)
	var got []string
	for i := range 50 {
		g := ids.Generator{Now: func() time.Time { return base.Add(time.Duration(i) * time.Millisecond) }}
		got = append(got, g.New(ids.PaymentIntent))
	}
	if !sort.StringsAreSorted(got) {
		t.Fatal("IDs created in later milliseconds must sort later")
	}
}

func TestParseRejectsWrongPrefixAndMalformedSuffix(t *testing.T) {
	good := ids.New(ids.PaymentIntent)
	for _, bad := range []string{
		"", "pi_", "op_" + good[3:], "pi_" + strings.ToUpper(good[3:]), good + "0", good[:len(good)-1],
		"pi_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
		"pi_00000000000040008000000000000000", // UUIDv4 layout, not v7
	} {
		if _, err := ids.Parse(ids.PaymentIntent, bad); !errors.Is(err, ids.ErrInvalid) {
			t.Errorf("Parse(pi_, %q) err = %v; want ErrInvalid", bad, err)
		}
	}
}

func TestEventIDIsCanonicalUUIDv7(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	if id := (ids.Generator{}).NewEventID(); !re.MatchString(id) {
		t.Fatalf("NewEventID = %q", id)
	}
}

func TestNoCollisionsInSameMillisecond(t *testing.T) {
	g := ids.Generator{Now: func() time.Time { return time.Unix(1, 0) }}
	seen := map[string]bool{}
	for range 10000 {
		id := g.New(ids.Operation)
		if seen[id] {
			t.Fatalf("duplicate %s", id)
		}
		seen[id] = true
	}
}

func TestInternalIDsAreSeparateUUIDv7s(t *testing.T) {
	id := ids.NewInternal()
	if _, err := ids.ParseInternal(id); err != nil {
		t.Fatalf("ParseInternal(%s): %v", id, err)
	}
	for _, bad := range []string{
		"", strings.ToUpper(id), strings.ReplaceAll(id, "-", ""),
		"8e03978e-40d5-43e8-bc93-6894a57f9324", // UUIDv4
		ids.NewPublic(ids.PaymentIntent),
	} {
		if _, err := ids.ParseInternal(bad); !errors.Is(err, ids.ErrInvalid) {
			t.Errorf("ParseInternal(%q) err = %v", bad, err)
		}
	}
	// A public ID is never accepted where an internal ID is expected, and vice versa.
	if _, err := ids.Parse(ids.PaymentIntent, id); !errors.Is(err, ids.ErrInvalid) {
		t.Error("internal ID accepted as a public ID")
	}
	if !regexp.MustCompile(ids.PublicIDPattern(ids.PaymentIntent)).MatchString(ids.NewPublic(ids.PaymentIntent)) {
		t.Error("PublicIDPattern does not match a fresh public ID")
	}
}
