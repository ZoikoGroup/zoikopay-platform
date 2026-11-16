package idempotency

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
)

// Header is the request header name (04-08 §4).
const Header = "Idempotency-Key"

// Errors from ParseHeader. All map to 400 idempotency_key_required.
var (
	ErrKeyMissing   = errors.New("the Idempotency-Key header is missing")
	ErrKeyRepeated  = errors.New("the Idempotency-Key header is repeated")
	ErrKeyMalformed = errors.New(`the Idempotency-Key header must be a quoted UUID, for example "8e03978e-40d5-43e8-bc93-6894a57f9324"`)
)

// Key is a validated idempotency key: a lowercase canonical UUID string.
type Key string

// ParseHeader validates the Idempotency-Key header values (as from
// http.Header.Values). 04-08 §4 adopts the RFC 9651 Structured Field string
// syntax: exactly one header whose value is a quoted, 36-character UUID.
// Missing, repeated, unquoted or malformed values are rejected.
func ParseHeader(values []string) (Key, error) {
	switch {
	case len(values) == 0:
		return "", ErrKeyMissing
	case len(values) > 1 || strings.Contains(values[0], ","):
		return "", ErrKeyRepeated
	}
	v := strings.TrimSpace(values[0])
	if v == "" {
		return "", ErrKeyMissing
	}
	if len(v) != 38 || v[0] != '"' || v[37] != '"' {
		return "", ErrKeyMalformed
	}
	u := strings.ToLower(v[1:37])
	if !isUUID(u) {
		return "", ErrKeyMalformed
	}
	return Key(u), nil
}

func isUUID(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
				return false
			}
		}
	}
	return len(s) == 36
}

// Digest is the stored form of a key: the raw key is never persisted
// (04-08 §6.2 "HMAC/hash of scope+key"). The scope is stored in its own
// columns and is part of the unique namespace.
func (k Key) Digest() []byte {
	h := sha256.Sum256([]byte("zoikopay:idem-key:v1\n" + string(k)))
	return h[:]
}

// String hides the key in logs; it may be echoed only to an entitled principal.
func (k Key) String() string { return fmt.Sprintf("idem-key(%x)", k.Digest()[:4]) }
