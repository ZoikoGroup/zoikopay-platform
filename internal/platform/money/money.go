package money

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
)

// MaxTransactionMinor is the provisional limit for ONE transaction amount,
// in minor units: 15 digits. It does NOT apply to balances, ledger totals or
// aggregates; those are only protected against int64 overflow.
// Status: provisional, awaiting owner approval (OPEN_QUESTIONS Q26).
const MaxTransactionMinor int64 = 999_999_999_999_999

// Errors returned by this package. Callers map them to validation_error (422),
// except ErrOverflow and ErrRoundingPolicyRequired, which block the operation.
var (
	ErrFormat           = errors.New("amount_minor must be a decimal integer string")
	ErrRange            = errors.New("amount is outside the supported integer range")
	ErrTransactionLimit = errors.New("amount exceeds the per-transaction limit")
	ErrOverflow         = errors.New("money arithmetic overflow")
	ErrCurrency         = errors.New("unsupported currency")
	ErrCurrencyMismatch = errors.New("currencies differ")
)

// Minor is an amount in minor units (for example pence), held in int64.
// math.MinInt64 is excluded so that every value can be negated safely.
// It marshals to a JSON string and only unmarshals from one.
type Minor int64

// ParseMinor parses the wire form of amount_minor strictly: an optional "-",
// then "0" or a digit 1-9 followed by digits. "-0", "+5", "01", "1.0",
// "1e3", spaces and empty strings are rejected (ErrFormat), as is anything
// outside ±(2^63-1) (ErrRange). It does not apply the transaction limit:
// use ParseTransaction for amounts of a single transaction.
func ParseMinor(s string) (Minor, error) {
	if !validDecimal(s) {
		return 0, fmt.Errorf("%w: %q", ErrFormat, s)
	}
	if len(s) > 20 {
		return 0, fmt.Errorf("%w: %s", ErrRange, s)
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil || v == math.MinInt64 {
		return 0, fmt.Errorf("%w: %s", ErrRange, s)
	}
	return Minor(v), nil
}

func validDecimal(s string) bool {
	digits := s
	if len(s) > 0 && s[0] == '-' {
		digits = s[1:]
		if digits == "0" {
			return false // "-0" has no meaning for money
		}
	}
	if digits == "" {
		return false
	}
	if digits[0] == '0' && len(digits) > 1 {
		return false
	}
	for i := 0; i < len(digits); i++ {
		if digits[i] < '0' || digits[i] > '9' {
			return false
		}
	}
	return true
}

// String returns the wire form, for example "1999".
func (m Minor) String() string { return strconv.FormatInt(int64(m), 10) }

// MarshalJSON writes the amount as a JSON string.
func (m Minor) MarshalJSON() ([]byte, error) {
	if int64(m) == math.MinInt64 {
		return nil, ErrRange
	}
	return []byte(`"` + m.String() + `"`), nil
}

// UnmarshalJSON accepts only a JSON string in the strict decimal form.
// A JSON number (even 1999) is rejected: ADR 0001 §3.
func (m *Minor) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || b[0] != '"' {
		return fmt.Errorf("%w: got a JSON %s", ErrFormat, jsonKind(b))
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("%w: %w", ErrFormat, err)
	}
	v, err := ParseMinor(s)
	if err != nil {
		return err
	}
	*m = v
	return nil
}

func jsonKind(b []byte) string {
	switch {
	case len(b) == 0:
		return "empty value"
	case b[0] == '{':
		return "object"
	case b[0] == '[':
		return "array"
	case bytes.Equal(b, []byte("null")):
		return "null"
	case b[0] == 't' || b[0] == 'f':
		return "boolean"
	default:
		return "number"
	}
}

// Money is an amount with its currency.
type Money struct {
	Amount   Minor    `json:"amount_minor"`
	Currency Currency `json:"currency"`
}

// New validates the currency and the integer range (not the transaction limit).
func New(amount int64, c Currency) (Money, error) {
	m := Money{Amount: Minor(amount), Currency: c}
	return m, m.Validate()
}

// Parse builds Money from the wire strings (integer range, not the transaction limit).
func Parse(amountMinor, currency string) (Money, error) {
	a, err := ParseMinor(amountMinor)
	if err != nil {
		return Money{}, err
	}
	c, err := ParseCurrency(currency)
	if err != nil {
		return Money{}, err
	}
	return Money{Amount: a, Currency: c}, nil
}

// ParseTransaction parses the amount of a single transaction and applies
// the per-transaction limit. Use it for every request amount.
func ParseTransaction(amountMinor, currency string) (Money, error) {
	m, err := Parse(amountMinor, currency)
	if err != nil {
		return Money{}, err
	}
	return m, m.ValidateTransaction()
}

// Validate checks the currency is supported and the amount is a valid Minor.
func (m Money) Validate() error {
	if _, err := ParseCurrency(string(m.Currency)); err != nil {
		return err
	}
	if int64(m.Amount) == math.MinInt64 {
		return ErrRange
	}
	return nil
}

// ValidateTransaction is Validate plus |amount| <= MaxTransactionMinor.
func (m Money) ValidateTransaction() error {
	if err := m.Validate(); err != nil {
		return err
	}
	if m.Amount > Minor(MaxTransactionMinor) || m.Amount < -Minor(MaxTransactionMinor) {
		return fmt.Errorf("%w: %s", ErrTransactionLimit, m)
	}
	return nil
}

// UnmarshalJSON decodes {"amount_minor":"…","currency":"…"} and validates it.
func (m *Money) UnmarshalJSON(b []byte) error {
	var raw struct {
		Amount   *Minor `json:"amount_minor"`
		Currency string `json:"currency"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if raw.Amount == nil {
		return fmt.Errorf("%w: amount_minor is required", ErrFormat)
	}
	c, err := ParseCurrency(raw.Currency)
	if err != nil {
		return err
	}
	*m = Money{Amount: *raw.Amount, Currency: c}
	return nil
}

// IsZero reports whether the amount is zero.
func (m Money) IsZero() bool { return m.Amount == 0 }

// IsNegative reports whether the amount is below zero.
func (m Money) IsNegative() bool { return m.Amount < 0 }

// String is for logs and errors, for example "1999 GBP" (minor units).
func (m Money) String() string { return m.Amount.String() + " " + string(m.Currency) }

// Add returns m + o. Both must have the same currency. Fails with ErrOverflow
// instead of wrapping; never rounds.
func (m Money) Add(o Money) (Money, error) {
	if m.Currency != o.Currency {
		return Money{}, fmt.Errorf("%w: %s + %s", ErrCurrencyMismatch, m.Currency, o.Currency)
	}
	a, b := int64(m.Amount), int64(o.Amount)
	s := a + b
	// Signed overflow happened iff both operands share a sign the result lacks.
	if (a >= 0) == (b >= 0) && (s >= 0) != (a >= 0) || s == math.MinInt64 {
		return Money{}, fmt.Errorf("%w: %s + %s", ErrOverflow, m, o)
	}
	return Money{Amount: Minor(s), Currency: m.Currency}, nil
}

// Sub returns m - o with the same rules as Add.
func (m Money) Sub(o Money) (Money, error) { return m.Add(o.Neg()) }

// Neg returns -m (always safe: math.MinInt64 is never a valid Minor).
func (m Money) Neg() Money { return Money{Amount: -m.Amount, Currency: m.Currency} }

// Cmp compares two amounts of the same currency: -1, 0 or +1.
func (m Money) Cmp(o Money) (int, error) {
	if m.Currency != o.Currency {
		return 0, fmt.Errorf("%w: %s vs %s", ErrCurrencyMismatch, m.Currency, o.Currency)
	}
	switch {
	case m.Amount < o.Amount:
		return -1, nil
	case m.Amount > o.Amount:
		return 1, nil
	}
	return 0, nil
}

// Sum adds amounts of one currency (balances, totals: no transaction limit).
// An empty list is zero in currency c.
func Sum(c Currency, items ...Money) (Money, error) {
	total, err := New(0, c)
	if err != nil {
		return Money{}, err
	}
	for _, it := range items {
		if total, err = total.Add(it); err != nil {
			return Money{}, err
		}
	}
	return total, nil
}
