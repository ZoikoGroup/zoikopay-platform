package archtest

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const m = ModulePath + "/internal/"

func TestCheckImportRules(t *testing.T) {
	tests := []struct {
		from, to string
		allowed  bool
	}{
		{m + "payment/app", m + "platform/money", true},
		{m + "payment/app", m + "payment/domain", true},
		{m + "payment/app", m + "eligibility", true},
		{m + "payment/app", m + "ledger/store", false},
		{m + "payment/store", m + "ledger/domain", false},
		{m + "platform/outbox", m + "payment", false},
		{m + "platform/outbox", m + "platform/db", true},
		{m + "payment/domain", "net/http", false},
		{m + "payment/domain", "github.com/jackc/pgx/v5", false},
		{m + "payment/domain", m + "payment/store", false},
		{m + "payment/domain", m + "payment/domain/states", true},
		{m + "payment/domain", m + "platform/money", true},
		{m + "payment/domain", "errors", true},
		{ModulePath + "/cmd/execution", m + "payment/store", true},
	}
	for _, tc := range tests {
		err := CheckImport(tc.from, tc.to)
		if (err == nil) != tc.allowed {
			t.Errorf("CheckImport(%q, %q) = %v, want allowed=%v", tc.from, tc.to, err, tc.allowed)
		}
	}
}

// TestRepositoryImportBoundaries scans every Go file under internal/ and
// fails on any import that breaks ADR 0002.
func TestRepositoryImportBoundaries(t *testing.T) {
	root := repoRoot(t)
	fset := token.NewFileSet()
	err := filepath.WalkDir(filepath.Join(root, "internal"), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, filepath.Dir(path))
		if err != nil {
			return err
		}
		from := ModulePath + "/" + filepath.ToSlash(rel)
		for _, imp := range f.Imports {
			to, err := strconv.Unquote(imp.Path.Value)
			if err != nil {
				return err
			}
			if err := CheckImport(from, to); err != nil {
				t.Errorf("%s: %v", path, err)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found")
		}
		dir = parent
	}
}
