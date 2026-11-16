// Package migrate is ZoikoPay's migration runner (ADR 0005 §4).
//
// Migrations are version-controlled SQL files in db/migrations/<module>/,
// named <version>_<name>.sql, in goose's file format (only the "-- +goose Up"
// section runs; migrations are forward-only, so "Down" sections are ignored).
// The runner adds what goose's CLI lacks:
//
//   - integrity: a SHA-256 of every applied file is recorded; a changed or
//     missing applied file stops the run before anything is applied;
//   - execution history: who applied what, when, how long, with which runner,
//     in an append-only table zp_migrations.history;
//   - one global PostgreSQL advisory lock, so concurrent runs serialize;
//   - each migration and its history row commit in ONE transaction;
//   - an expand–migrate–contract guard: destructive statements need an
//     explicit annotation.
//
// It is meant to run as zp_migrator, never as a runtime role.
package migrate

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Migration is one parsed file.
type Migration struct {
	Module        string
	Version       int64
	Name          string // file name
	Checksum      string // hex SHA-256 of the whole file
	Up            string // SQL that runs
	Transactional bool   // false with "-- +goose NO TRANSACTION"
	Contract      string // reason after "-- zp:contract", if any
	DataChange    string // reason after "-- zp:data-change", if any
}

var (
	moduleName = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	fileName   = regexp.MustCompile(`^([0-9]+)_([a-z0-9_]+)\.sql$`)
)

// ErrInvalidSource covers malformed directories and files.
var ErrInvalidSource = errors.New("invalid migration source")

// Load reads every module directory under root of fsys. Directories with no
// .sql files (for example only .gitkeep) are skipped.
func Load(fsys fs.FS) (map[string][]Migration, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("read migrations root: %w", err)
	}
	out := map[string][]Migration{}
	var problems []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		module := e.Name()
		files, err := fs.ReadDir(fsys, module)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", module, err)
		}
		var ms []Migration
		seen := map[int64]string{}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".sql") {
				continue
			}
			if !moduleName.MatchString(module) {
				problems = append(problems, fmt.Sprintf("%s: module directory must match %s", module, moduleName))
				break
			}
			m, err := parse(fsys, module, f.Name())
			if err != nil {
				problems = append(problems, err.Error())
				continue
			}
			if prev, dup := seen[m.Version]; dup {
				problems = append(problems, fmt.Sprintf("%s: version %d used by %s and %s", module, m.Version, prev, m.Name))
				continue
			}
			seen[m.Version] = m.Name
			ms = append(ms, m)
		}
		if len(ms) > 0 {
			sort.Slice(ms, func(i, j int) bool { return ms[i].Version < ms[j].Version })
			out[module] = ms
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return nil, fmt.Errorf("%w:\n  %s", ErrInvalidSource, strings.Join(problems, "\n  "))
	}
	return out, nil
}

func parse(fsys fs.FS, module, name string) (Migration, error) {
	match := fileName.FindStringSubmatch(name)
	if match == nil {
		return Migration{}, fmt.Errorf("%s/%s: file name must match <version>_<name>.sql (lower case)", module, name)
	}
	version, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil || version <= 0 {
		return Migration{}, fmt.Errorf("%s/%s: version must be a positive integer", module, name)
	}
	raw, err := fs.ReadFile(fsys, module+"/"+name)
	if err != nil {
		return Migration{}, fmt.Errorf("%s/%s: %w", module, name, err)
	}
	sum := sha256.Sum256(raw)
	m := Migration{Module: module, Version: version, Name: name, Checksum: hex.EncodeToString(sum[:]), Transactional: true}

	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	up, hasUp := sectionUp(text)
	if !hasUp {
		up = text
	}
	for _, line := range strings.Split(text, "\n") {
		l := strings.TrimSpace(line)
		switch {
		case strings.EqualFold(l, "-- +goose NO TRANSACTION"):
			m.Transactional = false
		case strings.HasPrefix(l, "-- zp:contract"):
			m.Contract = strings.TrimSpace(strings.TrimPrefix(l, "-- zp:contract"))
		case strings.HasPrefix(l, "-- zp:data-change"):
			m.DataChange = strings.TrimSpace(strings.TrimPrefix(l, "-- zp:data-change"))
		}
	}
	if strings.TrimSpace(stripNonCode(up)) == "" {
		return Migration{}, fmt.Errorf("%s/%s: no SQL in the Up section", module, name)
	}
	m.Up = up
	if err := checkExpandContract(m); err != nil {
		return Migration{}, err
	}
	return m, nil
}

// sectionUp returns the text between "-- +goose Up" and "-- +goose Down".
func sectionUp(text string) (string, bool) {
	lines := strings.Split(text, "\n")
	start := -1
	for i, line := range lines {
		l := strings.TrimSpace(line)
		if strings.EqualFold(l, "-- +goose Up") {
			start = i + 1
			continue
		}
		if start >= 0 && strings.EqualFold(l, "-- +goose Down") {
			return strings.Join(lines[start:i], "\n"), true
		}
	}
	if start < 0 {
		return "", false
	}
	return strings.Join(lines[start:], "\n"), true
}
