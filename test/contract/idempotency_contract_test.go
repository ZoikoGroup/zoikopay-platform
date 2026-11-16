// Package contract holds cross-cutting API contract tests (Spectral rule 2,
// api/openapi/.spectral.yaml): every POST operation in every OpenAPI contract
// must require the Idempotency-Key header parameter (04-08 §4, 04-02 §7).
package contract

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var (
	pathLine   = regexp.MustCompile(`^  (/[^:]*):\s*$`)
	methodLine = regexp.MustCompile(`^    (get|post|put|patch|delete):\s*$`)
)

// TestEveryPOSTRequiresIdempotencyKey reads the contracts as text (they are
// written in one consistent style) and checks each POST operation block for
// the shared IdempotencyKey parameter, which is declared required.
func TestEveryPOSTRequiresIdempotencyKey(t *testing.T) {
	specs, err := filepath.Glob(filepath.Join("..", "..", "api", "openapi", "*.v1.yaml"))
	if err != nil || len(specs) == 0 {
		t.Fatalf("no OpenAPI contracts found: %v", err)
	}
	posts := 0
	for _, spec := range specs {
		raw, err := os.ReadFile(spec) //nolint:gosec // G304: test reads repository files.
		if err != nil {
			t.Fatal(err)
		}
		text := string(raw)
		if strings.Contains(text, "#/components/parameters/IdempotencyKey") &&
			!regexp.MustCompile(`(?s)IdempotencyKey:\s*\n\s*name: Idempotency-Key\s*\n\s*in: header\s*\n\s*required: true`).MatchString(text) {
			t.Errorf("%s: IdempotencyKey parameter must be a required header", spec)
		}
		lines := strings.Split(text, "\n")
		path, method := "", ""
		block := []string{}
		check := func() {
			if method == "post" {
				posts++
				if !strings.Contains(strings.Join(block, "\n"), "#/components/parameters/IdempotencyKey") {
					t.Errorf("%s: POST %s does not require Idempotency-Key", filepath.Base(spec), path)
				}
			}
		}
		for _, l := range lines {
			if m := pathLine.FindStringSubmatch(l); m != nil {
				check()
				path, method, block = m[1], "", nil
				continue
			}
			if m := methodLine.FindStringSubmatch(l); m != nil {
				check()
				method, block = m[1], nil
				continue
			}
			if strings.HasPrefix(l, "components:") {
				check()
				path, method = "", ""
			}
			block = append(block, l)
		}
		check()
	}
	if posts == 0 {
		t.Fatal("expected at least one POST operation to check")
	}
}
