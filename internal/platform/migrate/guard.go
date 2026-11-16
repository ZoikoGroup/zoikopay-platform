package migrate

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// ErrUnannotated is returned for a destructive or data-changing statement
// without its annotation.
var ErrUnannotated = errors.New("unannotated destructive migration")

// Statement classes (ADR 0005 §4.3, expand–migrate–contract):
//   - contract: removes or reshapes something an older application version
//     may still use. Needs "-- zp:contract <reason>", and may only ship after
//     every running version stopped using the old shape.
//   - data change: rewrites or removes rows. Needs "-- zp:data-change <reason>"
//     (the brief forbids silently converting or discarding financial data).
var (
	contractStmt = []*regexp.Regexp{
		regexp.MustCompile(`^DROP\s`),
		regexp.MustCompile(`^ALTER\s.*\sRENAME\s`),
		regexp.MustCompile(`^ALTER\s+TABLE\s.*\sDROP\s`),
		regexp.MustCompile(`^ALTER\s+TABLE\s.*\sALTER\s+(COLUMN\s+)?\S+\s+(SET\s+DATA\s+)?TYPE\s`),
		regexp.MustCompile(`^ALTER\s+TABLE\s.*\sALTER\s+(COLUMN\s+)?\S+\s+SET\s+NOT\s+NULL`),
	}
	dataStmt = []*regexp.Regexp{
		regexp.MustCompile(`^(TRUNCATE|DELETE|UPDATE)\s`),
		regexp.MustCompile(`^WITH\s.*\s(DELETE|UPDATE)\s`),
	}
)

func checkExpandContract(m Migration) error {
	var problems []string
	for _, stmt := range statements(m.Up) {
		u := strings.ToUpper(stmt)
		for _, re := range contractStmt {
			if re.MatchString(u) && m.Contract == "" {
				problems = append(problems, fmt.Sprintf("contract statement needs \"-- zp:contract <reason>\": %s", short(stmt)))
				break
			}
		}
		for _, re := range dataStmt {
			if re.MatchString(u) && m.DataChange == "" {
				problems = append(problems, fmt.Sprintf("data change needs \"-- zp:data-change <reason>\": %s", short(stmt)))
				break
			}
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("%w: %s/%s: %s", ErrUnannotated, m.Module, m.Name, strings.Join(problems, "; "))
	}
	return nil
}

// statements splits SQL into top-level statements with comments, string
// literals and dollar-quoted bodies blanked out, whitespace collapsed.
func statements(sql string) []string {
	var out []string
	for _, s := range strings.Split(stripNonCode(sql), ";") {
		s = strings.Join(strings.Fields(s), " ")
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// stripNonCode replaces comments, quoted strings, quoted identifiers and
// dollar-quoted bodies with spaces, so keywords inside them are ignored.
func stripNonCode(sql string) string {
	var b strings.Builder
	n := len(sql)
	for i := 0; i < n; {
		c := sql[i]
		switch {
		case c == '-' && i+1 < n && sql[i+1] == '-':
			for i < n && sql[i] != '\n' {
				i++
			}
			b.WriteByte(' ')
		case c == '/' && i+1 < n && sql[i+1] == '*':
			end := strings.Index(sql[i+2:], "*/")
			if end < 0 {
				i = n
			} else {
				i += end + 4
			}
			b.WriteByte(' ')
		case c == '\'' || c == '"':
			i++
			for i < n {
				if sql[i] == c {
					if i+1 < n && sql[i+1] == c { // doubled quote escape
						i += 2
						continue
					}
					i++
					break
				}
				i++
			}
			b.WriteString(" x ")
		case c == '$':
			j := i + 1
			for j < n && (sql[j] == '_' || sql[j] >= 'a' && sql[j] <= 'z' || sql[j] >= 'A' && sql[j] <= 'Z' || sql[j] >= '0' && sql[j] <= '9') {
				j++
			}
			if j < n && sql[j] == '$' {
				tag := sql[i : j+1]
				end := strings.Index(sql[j+1:], tag)
				if end < 0 {
					i = n
				} else {
					i = j + 1 + end + len(tag)
				}
				b.WriteString(" x ")
				continue
			}
			b.WriteByte(c)
			i++
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String()
}

func short(s string) string {
	if len(s) > 80 {
		return s[:80] + "…"
	}
	return s
}
