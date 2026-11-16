package idempotency

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// FingerprintVersion tags the algorithm below (04-08 §5.3).
const FingerprintVersion = "zp-fp-v1"

// Input is the canonical basis of a request fingerprint (04-08 §5.1, §5.3).
// Build Body from the validated, typed request; include every field that can
// change a financial, legal, routing or beneficiary result. Never include
// tenant, merchant or cell from the request: scope is server-derived and lives
// in Scope. Never include trace headers.
type Input struct {
	OperationKind string            // for example "payment_intent.create"
	Method        string            // "POST"
	Route         string            // route template, for example "/v1/payment_intents/{id}/capture"
	PathParams    map[string]string // resolved path parameters
	Body          map[string]any    // validated body; amounts as strings
}

// Fingerprint returns SHA-256("zoikopay:req-fp:v1\n" || JCS(input)).
func Fingerprint(in Input) ([]byte, error) {
	params := map[string]any{}
	for k, v := range in.PathParams {
		params[k] = v
	}
	body := in.Body
	if body == nil {
		body = map[string]any{}
	}
	canon, err := Canonicalize(map[string]any{
		"fingerprint_version": FingerprintVersion,
		"operation_kind":      in.OperationKind,
		"method":              in.Method,
		"route":               in.Route,
		"path_params":         params,
		"body":                body,
	})
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	h.Write([]byte("zoikopay:req-fp:v1\n"))
	h.Write(canon)
	return h.Sum(nil), nil
}

// ErrNotCanonicalizable is returned for values JCS cannot represent safely.
var ErrNotCanonicalizable = errors.New("value cannot be canonicalized")

// maxSafeInt is 2^53-1: integers beyond it are not exact in I-JSON (RFC 7493).
const maxSafeInt = 1<<53 - 1

// Canonicalize serializes v with the RFC 8785 JSON Canonicalization Scheme.
// Supported values: nil, bool, string, integers within ±(2^53-1) (int, int64,
// json.Number), map[string]any and []any (also []string, map[string]string).
// Non-integer numbers are rejected: money is a string, and no fingerprinted
// field may depend on float formatting.
func Canonicalize(v any) ([]byte, error) {
	var b bytes.Buffer
	if err := canon(&b, v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func canon(b *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case string:
		return canonString(b, x)
	case int:
		return canonInt(b, int64(x))
	case int64:
		return canonInt(b, x)
	case json.Number:
		i, err := x.Int64()
		if err != nil {
			return fmt.Errorf("%w: non-integer number %s", ErrNotCanonicalizable, x)
		}
		return canonInt(b, i)
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := canon(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case []string:
		arr := make([]any, len(x))
		for i, s := range x {
			arr[i] = s
		}
		return canon(b, arr)
	case map[string]string:
		m := make(map[string]any, len(x))
		for k, s := range x {
			m[k] = s
		}
		return canon(b, m)
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			if !utf8.ValidString(k) {
				return fmt.Errorf("%w: invalid UTF-8 key", ErrNotCanonicalizable)
			}
			keys = append(keys, k)
		}
		// RFC 8785 §3.2.3: sort by UTF-16 code units.
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := canonString(b, k); err != nil {
				return err
			}
			b.WriteByte(':')
			if err := canon(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("%w: unsupported type %T", ErrNotCanonicalizable, v)
	}
	return nil
}

func canonInt(b *bytes.Buffer, i int64) error {
	if i > maxSafeInt || i < -maxSafeInt {
		return fmt.Errorf("%w: integer %d outside I-JSON range", ErrNotCanonicalizable, i)
	}
	b.WriteString(strconv.FormatInt(i, 10))
	return nil
}

// canonString writes s as ECMAScript JSON.stringify does (RFC 8785 §3.2.2.2):
// escape quote, backslash and control characters; leave everything else,
// including "/" and non-ASCII, as literal UTF-8.
func canonString(b *bytes.Buffer, s string) error {
	if !utf8.ValidString(s) {
		return fmt.Errorf("%w: invalid UTF-8 string", ErrNotCanonicalizable)
	}
	const hexDigits = "0123456789abcdef"
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if c < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(hexDigits[c>>4])
				b.WriteByte(hexDigits[c&0xf])
			} else {
				b.WriteByte(c)
			}
		}
	}
	b.WriteByte('"')
	return nil
}

func lessUTF16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}
