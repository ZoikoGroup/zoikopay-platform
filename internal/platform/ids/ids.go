// Package ids generates and validates the platform's identifiers.
//
// Four kinds of identifier exist and are never interchanged (Module 1
// decision 3, ADR 0005 §2):
//
//   - Internal ID: a UUIDv7, the primary key of a row (`uuid` column). Never
//     shown to clients. NewInternal.
//   - Public ID: a type prefix plus 32 lowercase hex digits of an independent
//     UUIDv7, for example pi_0196f3…  (ADR 0001 §6). Shown to clients, unique
//     and format-checked in the database (PublicIDCheckSQL). NewPublic.
//   - Event ID: a UUIDv7 in canonical 8-4-4-4-12 form (04-06 §3.1). NewEventID.
//   - Idempotency key: chosen by the client; see package idempotency.
//
// UUIDv7 puts the creation time first, so IDs of one kind sort by creation time.
package ids

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Prefix is a public ID type prefix, including the trailing underscore.
type Prefix string

// Prefixes fixed by ADR 0001 §6. Others are added when their resource is
// first built (OPEN_QUESTIONS Q10, Q15).
const (
	PaymentIntent Prefix = "pi_"
	Operation     Prefix = "op_"
	Refund        Prefix = "re_"
	Merchant      Prefix = "mer_"
	// Tenant is proposed, not yet frozen: first built by BC-01 (ADR 0001 §6, Q15).
	Tenant Prefix = "ten_"
	// Grant administration (BC-01, OPEN_QUESTIONS Q40). Proposed, not yet frozen.
	Invitation    Prefix = "inv_"
	AccessRequest Prefix = "acr_"
	Membership    Prefix = "mbr_"
)

const suffixLen = 32

// ErrInvalid is returned for an ID that is malformed or has the wrong prefix.
var ErrInvalid = errors.New("invalid identifier")

// Generator creates IDs. Now supplies the timestamp (injectable for tests);
// when nil, the system clock is used.
type Generator struct {
	Now func() time.Time
}

// NewPublic returns a fresh public ID with prefix p using the system clock.
func NewPublic(p Prefix) string { return Generator{}.NewPublic(p) }

// NewInternal returns a fresh internal row ID (canonical UUIDv7 string).
func NewInternal() string { return Generator{}.NewInternal() }

// New is NewPublic, kept for callers that predate the internal/public split.
func New(p Prefix) string { return NewPublic(p) }

// NewPublic returns a fresh public ID with prefix p.
func (g Generator) NewPublic(p Prefix) string {
	u := g.UUIDv7()
	return string(p) + hex.EncodeToString(u[:])
}

// New is NewPublic.
func (g Generator) New(p Prefix) string { return g.NewPublic(p) }

// NewInternal returns a canonical UUIDv7 string for a primary key.
func (g Generator) NewInternal() string { return canonical(g.UUIDv7()) }

// NewEventID returns a canonical UUIDv7 string for a CloudEvents id.
func (g Generator) NewEventID() string { return canonical(g.UUIDv7()) }

func canonical(u [16]byte) string {
	h := hex.EncodeToString(u[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// UUIDv7 returns a random RFC 9562 version 7 UUID.
func (g Generator) UUIDv7() [16]byte {
	now := time.Now
	if g.Now != nil {
		now = g.Now
	}
	var u [16]byte
	if _, err := rand.Read(u[6:]); err != nil {
		// crypto/rand never fails on supported platforms (Go 1.24+ panics internally).
		panic(fmt.Sprintf("ids: crypto/rand: %v", err))
	}
	ms := uint64(now().UnixMilli())
	var ts [8]byte
	binary.BigEndian.PutUint64(ts[:], ms<<16)
	copy(u[0:6], ts[0:6])
	u[6] = (u[6] & 0x0f) | 0x70 // version 7
	u[8] = (u[8] & 0x3f) | 0x80 // RFC 9562 variant
	return u
}

// Parse checks that id has prefix p and a well-formed UUIDv7 suffix.
// It returns the ID unchanged when valid.
func Parse(p Prefix, id string) (string, error) {
	suffix, ok := strings.CutPrefix(id, string(p))
	if !ok || len(suffix) != suffixLen {
		return "", fmt.Errorf("%w: want %s<%d hex>", ErrInvalid, p, suffixLen)
	}
	b, err := hex.DecodeString(suffix)
	if err != nil || strings.ToLower(suffix) != suffix {
		return "", fmt.Errorf("%w: suffix must be lowercase hex", ErrInvalid)
	}
	if b[6]>>4 != 7 || b[8]>>6 != 2 {
		return "", fmt.Errorf("%w: suffix is not a UUIDv7", ErrInvalid)
	}
	return id, nil
}

// ParseInternal checks a canonical lowercase UUIDv7 string.
func ParseInternal(id string) (string, error) {
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
		return "", fmt.Errorf("%w: want a canonical UUID", ErrInvalid)
	}
	compact := strings.ReplaceAll(id, "-", "")
	b, err := hex.DecodeString(compact)
	if err != nil || strings.ToLower(id) != id {
		return "", fmt.Errorf("%w: must be lowercase hex", ErrInvalid)
	}
	if b[6]>>4 != 7 || b[8]>>6 != 2 {
		return "", fmt.Errorf("%w: not a UUIDv7", ErrInvalid)
	}
	return id, nil
}

// PublicIDPattern is the PostgreSQL regular expression for prefix p: the
// prefix, 12 hex digits, the version nibble 7, 3 hex digits, the variant
// nibble 8-b, then 15 hex digits.
func PublicIDPattern(p Prefix) string {
	return "^" + string(p) + "[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$"
}

// PublicIDCheckSQL returns a column CHECK enforcing the public ID format.
// Use with UNIQUE on the same column. p must be one of the package constants.
func PublicIDCheckSQL(column string, p Prefix) string {
	return fmt.Sprintf("CHECK (%s ~ '%s')", column, PublicIDPattern(p))
}

// InternalIDCheckSQL returns a column CHECK enforcing a UUIDv7 (PostgreSQL 18
// uuid_extract_version).
func InternalIDCheckSQL(column string) string {
	return fmt.Sprintf("CHECK (uuid_extract_version(%s) = 7)", column)
}
