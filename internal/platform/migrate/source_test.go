package migrate

import (
	"errors"
	"strings"
	"testing"
	"testing/fstest"
)

func file(s string) *fstest.MapFile { return &fstest.MapFile{Data: []byte(s)} }

func TestLoadParsesGooseFormatAndIgnoresDown(t *testing.T) {
	src, err := Load(fstest.MapFS{
		"payment/00001_init.sql":  file("-- +goose Up\nCREATE TABLE a (id int);\n-- +goose Down\nDROP TABLE a;\n"),
		"payment/00002_index.sql": file("-- +goose NO TRANSACTION\n-- +goose Up\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON a (id);\n"),
		"ledger/.gitkeep":         file(""),
		"payment/README.txt":      file("not sql"),
	})
	if err != nil {
		t.Fatal(err)
	}
	ms := src["payment"]
	if len(src) != 1 || len(ms) != 2 {
		t.Fatalf("loaded %v", src)
	}
	if strings.Contains(ms[0].Up, "DROP") {
		t.Fatal("the Down section must never run")
	}
	if !ms[0].Transactional || ms[1].Transactional {
		t.Fatal("NO TRANSACTION directive not honored")
	}
	if len(ms[0].Checksum) != 64 {
		t.Fatal("checksum must be SHA-256 hex")
	}
}

func TestLoadRejectsBadSources(t *testing.T) {
	for name, fs := range map[string]fstest.MapFS{
		"bad file name":     {"payment/1-init.sql": file("CREATE TABLE a (id int);")},
		"upper case name":   {"payment/00001_Init.sql": file("CREATE TABLE a (id int);")},
		"zero version":      {"payment/0_init.sql": file("CREATE TABLE a (id int);")},
		"duplicate version": {"payment/1_a.sql": file("CREATE TABLE a (id int);"), "payment/001_b.sql": file("CREATE TABLE b (id int);")},
		"empty up":          {"payment/1_a.sql": file("-- +goose Up\n-- nothing here\n-- +goose Down\nDROP TABLE a;")},
		"bad module":        {"Payment/1_a.sql": file("CREATE TABLE a (id int);")},
	} {
		if _, err := Load(fs); !errors.Is(err, ErrInvalidSource) {
			t.Errorf("%s: err = %v; want ErrInvalidSource", name, err)
		}
	}
}

func TestExpandContractGuard(t *testing.T) {
	needsContract := []string{
		"DROP TABLE a;",
		"drop index if exists i;",
		"ALTER TABLE a DROP COLUMN b;",
		"ALTER TABLE a RENAME COLUMN b TO c;",
		"ALTER TABLE a ALTER COLUMN b TYPE bigint;",
		"ALTER TABLE a ALTER b SET DATA TYPE text;",
		"ALTER TABLE a ALTER COLUMN b SET NOT NULL;",
	}
	needsData := []string{
		"UPDATE a SET b = 1;",
		"DELETE FROM a;",
		"TRUNCATE a;",
		"WITH x AS (SELECT 1) DELETE FROM a;",
	}
	for _, sql := range needsContract {
		if _, err := Load(fstest.MapFS{"m/1_x.sql": file(sql)}); !errors.Is(err, ErrInvalidSource) || !strings.Contains(err.Error(), "zp:contract") {
			t.Errorf("%q should need zp:contract: %v", sql, err)
		}
		if _, err := Load(fstest.MapFS{"m/1_x.sql": file("-- zp:contract old readers removed in release 12\n" + sql)}); err != nil {
			t.Errorf("%q with annotation: %v", sql, err)
		}
	}
	for _, sql := range needsData {
		if _, err := Load(fstest.MapFS{"m/1_x.sql": file(sql)}); err == nil || !strings.Contains(err.Error(), "zp:data-change") {
			t.Errorf("%q should need zp:data-change: %v", sql, err)
		}
	}
	// Expand statements, and keywords inside comments, strings and function
	// bodies, are not destructive.
	safe := `
CREATE TABLE a (id int, note text);
ALTER TABLE a ADD COLUMN extra text NULL;
CREATE INDEX i ON a (id);
-- DROP TABLE a;  (a comment)
COMMENT ON TABLE a IS 'never DROP TABLE this; DELETE FROM is forbidden';
CREATE FUNCTION g() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'no'; END IF; DELETE FROM x; RETURN NEW; END $$;
CREATE TRIGGER t BEFORE TRUNCATE ON a FOR EACH STATEMENT EXECUTE FUNCTION g();
`
	if _, err := Load(fstest.MapFS{"m/1_x.sql": file(safe)}); err != nil {
		t.Fatalf("expand-only migration rejected: %v", err)
	}
}

func TestPlanDetectsTamperingMissingAndOutOfOrder(t *testing.T) {
	src, err := Load(fstest.MapFS{
		"m/1_a.sql": file("CREATE TABLE a (id int);"),
		"m/2_b.sql": file("CREATE TABLE b (id int);"),
		"m/3_c.sql": file("CREATE TABLE c (id int);"),
	})
	if err != nil {
		t.Fatal(err)
	}
	h := func(rows map[int64]string) map[string]map[int64]historyRow {
		out := map[string]map[int64]historyRow{"m": {}}
		for v, sum := range rows {
			out["m"][v] = historyRow{name: "f", checksum: sum}
		}
		return out
	}
	sum := func(v int64) string { return src["m"][v-1].Checksum }

	if p, err := plan(src, h(map[int64]string{1: sum(1)})); err != nil || len(p) != 2 {
		t.Fatalf("normal plan = %v, %v", p, err)
	}
	if _, err := plan(src, h(map[int64]string{1: strings.Repeat("0", 64)})); !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("tampered file err = %v", err)
	}
	if _, err := plan(src, h(map[int64]string{1: sum(1), 3: sum(3)})); !errors.Is(err, ErrOutOfOrder) {
		t.Fatalf("out of order err = %v", err)
	}
	withGhost := h(map[int64]string{1: sum(1)})
	withGhost["gone"] = map[int64]historyRow{1: {name: "1_x.sql", checksum: strings.Repeat("a", 64)}}
	if _, err := plan(src, withGhost); !errors.Is(err, ErrMissingFile) {
		t.Fatalf("missing file err = %v", err)
	}
}

func TestScaffoldRejectsBadNames(t *testing.T) {
	for _, p := range []PlatformTables{
		{Module: "Pay", Schema: "pay", WriterRole: "zp_execution", RelayRole: "zp_relay"},
		{Module: "pay", Schema: "pay;drop", WriterRole: "zp_execution", RelayRole: "zp_relay"},
		{Module: "pay", Schema: "pay", WriterRole: "postgres", RelayRole: "zp_relay"},
	} {
		if _, err := PlatformTablesSQL(p); err == nil {
			t.Errorf("%+v accepted", p)
		}
	}
	sql, err := PlatformTablesSQL(PlatformTables{Module: "pay", Schema: "pay", WriterRole: "zp_execution", RelayRole: "zp_relay"})
	if err != nil {
		t.Fatal(err)
	}
	// The generated file must pass the runner's own checks.
	if _, err := Load(fstest.MapFS{"pay/00001_platform_tables.sql": file(sql)}); err != nil {
		t.Fatalf("scaffold output fails Load: %v", err)
	}
}
