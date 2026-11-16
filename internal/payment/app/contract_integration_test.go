//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/zoiko/zoikopay/internal/payment/app"
	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
	"github.com/zoiko/zoikopay/internal/platform/migrate"
	"github.com/zoiko/zoikopay/internal/platform/outbox"
)

type propSchema struct {
	Type    any      `json:"type"`
	Pattern string   `json:"pattern"`
	Enum    []string `json:"enum"`
}

type eventSchema struct {
	ID         string                `json:"$id"`
	Required   []string              `json:"required"`
	Properties map[string]propSchema `json:"properties"`
	Additional *bool                 `json:"additionalProperties"`
}

// Every event BC-03 wrote conforms to its versioned schema in
// api/events/payment (04-06 §6; 06-01 PI-038).
func TestEmittedEventsMatchTheirSchemas(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	// Produce every event type: auto success, manual auth + capture, unknown.
	a := create(t, e, A, "automatic")
	aop := confirm(t, e, A, a.ID)
	_ = e.observe(obs{opID: aop.ID, outcome: "PROVIDER_EXECUTION_SUCCESS", amount: minor(1999)})
	m := create(t, e, A, "manual")
	mop := confirm(t, e, A, m.ID)
	_ = e.observe(obs{opID: mop.ID, outcome: "PROVIDER_AUTHORIZED", amount: minor(1999)})
	cap, err := e.svc.CaptureIntent(ctx, A, key(t), m.ID, app.CaptureRequest{Amount: 1999})
	if err != nil {
		t.Fatal(err)
	}
	_ = e.observe(obs{opID: cap.Op.ID, outcome: "CAPTURE_UNKNOWN"})

	schemas := map[string]eventSchema{}
	files, _ := filepath.Glob(filepath.Join(dbtest.RepoRoot(t), "api", "events", "payment", "*.schema.json"))
	for _, f := range files {
		raw, err := os.ReadFile(f) //nolint:gosec // G304: repository file in a test.
		if err != nil {
			t.Fatal(err)
		}
		var s eventSchema
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatal(err)
		}
		schemas[strings.TrimPrefix(s.ID, "urn:zoikopay:schema:")] = s
	}
	rows, err := e.relay.Query(ctx, `SELECT event_type, envelope FROM payment.outbox_events`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := map[string]int{}
	for rows.Next() {
		var typ string
		var env []byte
		if err := rows.Scan(&typ, &env); err != nil {
			t.Fatal(err)
		}
		var ev outbox.Event
		if err := json.Unmarshal(env, &ev); err != nil {
			t.Fatal(err)
		}
		if err := ev.Validate(); err != nil {
			t.Errorf("%s envelope: %v", typ, err)
		}
		if ev.DataSchema != "urn:zoikopay:schema:"+typ {
			t.Errorf("%s dataschema = %s", typ, ev.DataSchema)
		}
		s, ok := schemas[typ]
		if !ok {
			t.Errorf("no schema for %s", typ)
			continue
		}
		seen[typ]++
		if err := conforms(ev.Data, s); err != nil {
			t.Errorf("%s: %v", typ, err)
		}
	}
	if len(seen) != 5 {
		t.Fatalf("event types produced = %v; want all five", seen)
	}
}

func conforms(data []byte, s eventSchema) error {
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}
	for _, r := range s.Required {
		if _, ok := m[r]; !ok {
			return fmt.Errorf("missing required %q", r)
		}
	}
	for k, v := range m {
		p, ok := s.Properties[k]
		if !ok {
			if s.Additional != nil && !*s.Additional {
				return fmt.Errorf("field %q not in schema", k)
			}
			continue
		}
		str, isStr := v.(string)
		if p.Pattern != "" && (!isStr || !regexp.MustCompile(p.Pattern).MatchString(str)) {
			return fmt.Errorf("%s=%v does not match %s", k, v, p.Pattern)
		}
		if len(p.Enum) > 0 {
			found := false
			for _, e := range p.Enum {
				found = found || e == str
			}
			if !found {
				return fmt.Errorf("%s=%v not in %v", k, v, p.Enum)
			}
		}
	}
	return nil
}

// The payment migrations are independently versioned: re-running applies
// nothing, history holds a checksum per file, and the files pass the
// expand–contract checks (ADR 0005 §4).
func TestPaymentMigrationsAreRepeatable(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	src := os.DirFS(filepath.Join(dbtest.RepoRoot(t), "db", "migrations"))
	r := migrate.Runner{Pool: e.pg.Pool(t, "zp_migrator"), Source: src}
	if again, err := r.Up(ctx); err != nil || len(again) != 0 {
		t.Fatalf("second run = %v, %v", again, err)
	}
	st, err := r.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	payment := 0
	for _, s := range st {
		if s.Module == "payment" {
			payment++
			if s.State != migrate.StateApplied {
				t.Errorf("%s is %s", s.Name, s.State)
			}
		}
	}
	if payment != 2 {
		t.Fatalf("payment migrations = %d; want 2", payment)
	}
	var sums int
	if err := e.pg.Pool(t, "zp_migrator").QueryRow(ctx, `SELECT count(*) FROM zp_migrations.history WHERE module = 'payment' AND checksum_sha256 ~ '^[0-9a-f]{64}$'`).Scan(&sums); err != nil || sums != 2 {
		t.Fatalf("checksummed history rows = %d, %v", sums, err)
	}
}
