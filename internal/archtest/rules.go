// Package archtest enforces the module import boundaries from ADR 0002.
// The rules run as an ordinary Go test, so `make test` fails on a violation.
package archtest

import (
	"fmt"
	"strings"
)

// ModulePath is the Go module path of this repository.
const ModulePath = "github.com/zoiko/zoikopay"

const internalPrefix = ModulePath + "/internal/"

// businessModules are the nine bounded contexts (BC-01..BC-09).
var businessModules = map[string]bool{
	"merchant": true, "eligibility": true, "payment": true, "connector": true,
	"ledger": true, "recon": true, "billing": true, "governance": true, "notify": true,
}

// forbiddenInDomain are imports that would give a domain/ package I/O.
var forbiddenInDomain = []string{
	"database/sql", "net/http", "os", "os/exec",
	"github.com/jackc/pgx", "go.temporal.io",
}

// pkgInfo locates a package path within the repository layout.
type pkgInfo struct {
	internal bool   // under internal/
	module   string // first segment after internal/ ("payment", "platform", ...)
	sub      string // rest of the path after the module ("domain", "store/q", "")
}

func classify(importPath string) pkgInfo {
	rest, ok := strings.CutPrefix(importPath, internalPrefix)
	if !ok {
		return pkgInfo{}
	}
	module, sub, _ := strings.Cut(rest, "/")
	return pkgInfo{internal: true, module: module, sub: sub}
}

// CheckImport reports whether package `from` may import package `to`.
// Both are full import paths. It returns nil when the import is allowed.
func CheckImport(from, to string) error {
	src := classify(from)
	if !src.internal {
		return nil // cmd/ and test/ may wire anything together
	}
	dst := classify(to)

	// Rule 1: platform is the shared kernel; it must not depend on business modules.
	if src.module == "platform" && dst.internal && businessModules[dst.module] {
		return fmt.Errorf("platform package %s must not import business module %s", from, to)
	}

	// Rule 2: a business module may use another module only through its root
	// contract package, never through that module's internals.
	if businessModules[src.module] && dst.internal && businessModules[dst.module] &&
		dst.module != src.module && dst.sub != "" {
		return fmt.Errorf("%s imports internals of module %q (%s); use the module's root contract package or an outbox event",
			from, dst.module, to)
	}

	// Rule 3: domain/ packages are pure logic with no I/O.
	if businessModules[src.module] && isDomain(src.sub) {
		for _, f := range forbiddenInDomain {
			if to == f || strings.HasPrefix(to, f+"/") {
				return fmt.Errorf("domain package %s must not import %s (no I/O in domain/)", from, to)
			}
		}
		if dst.internal && dst.module == src.module && !isDomain(dst.sub) {
			return fmt.Errorf("domain package %s must not import %s (domain/ depends on nothing else in its module)", from, to)
		}
	}
	return nil
}

func isDomain(sub string) bool { return sub == "domain" || strings.HasPrefix(sub, "domain/") }
