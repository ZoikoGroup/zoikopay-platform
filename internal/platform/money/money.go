package money

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
)

// MaxMinor is the largest absolute amount the platform accepts, in minor
// units: 15 digits. int64 could hold 18, but every amount must also fit the
// exact-integer range of the clients that read our JSON and leave headroom
// for sums. Proposed in OPEN_QUESTIONS Q26 (Q2 chose int64 "with an API maximum").
const MaxMinor int64 = 999_999_999_999_999

// Errors returned by this package. Callers map them to validation_error (422).
var (
	ErrFormat           = errors.New("amount_minor must be a decimal integer string")
	ErrRange            = errors.New("amount_minor is outside the allowed range")
	ErrCurrency         = errors.New("unsupported currency")
	ErrCurrencyMismatch = errors.New("currencies differ")
)

// Minor is an amount in minor units (for example pence). It marshals to a
// JSON string and only unmarshals from one.
type Minor int64

// ParseMinor parses the wire form of amount_minor strictly: an optional "-",
// then "0" or a digit 1-9 followed by digits. "-0", "+5", "01", "1.0",
// "1e3", spaces and empty strings are rejected, as is anything beyond MaxMinor.
func ParseMinor(s string) (Minor, error) {
	if !validDecimal(s) {
		return 0, fmt.Errorf("%w: %q", ErrFormat, s)
	}
	// Longer than 1 sign + 18 digits cannot be in range; reject before parsing.
	if len(s) > 19 {
		return 0, fmt.Errorf("%w: %s", ErrRange, s)
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: %s", ErrRange, s)
	}
	m := Minor(v)
	if err := m.check(); err != nil {
		return 0, err
	}
	return m, nil
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

func (m Minor) check() error {
	if m > Minor(MaxMinor) || m < -Minor(MaxMinor) {
		return fmt.Errorf("%w: %d", ErrRange, int64(m))
	}
	return nil
}

// String returns the wire form, for example "1999".
func (m Minor) String() string { return strconv.FormatInt(int64(m), 10) }

// MarshalJSON writes the amount as a JSON string.
func (m Minor) MarshalJSON() ([]byte, error) {
	if err := m.check(); err != nil {
		return nil, err
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

// Money is an amount with its currency. Construct it with New or Parse so the
// currency and range are checked.
type Money struct {
	Amount   Minor    `json:"amount_minor"`
	Currency Currency `json:"currency"`
}

// New validates amount and currency.
func New(amount int64, c Currency) (Money, error) {
	m := Money{Amount: Minor(amount), Currency: c}
	return m, m.Validate()
}

// Parse builds Money from the wire strings.
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

// Validate checks the currency is supported and the amount is in range.
func (m Money) Validate() error {
	if _, err := ParseCurrency(string(m.Currency)); err != nil {
		return err
	}
	return m.Amount.check()
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

// Add returns m + o. Both must have the same currency; the result must stay in range.
func (m Money) Add(o Money) (Money, error) {
	if m.Currency != o.Currency {
		return Money{}, fmt.Errorf("%w: %s + %s", ErrCurrencyMismatch, m.Currency, o.Currency)
	}
	sum := Money{Amount: m.Amount + o.Amount, Currency: m.Currency}
	// Both operands are within ±MaxMinor, so the int64 sum cannot overflow;
	// only the range check can fail.
	if err := sum.Amount.check(); err != nil {
		return Money{}, err
	}
	return sum, nil
}

// Sub returns m - o. Both must have the same currency; the result must stay in range.
func (m Money) Sub(o Money) (Money, error) {
	return m.Add(o.Neg())
}

// Neg returns -m.
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

// Sum adds amounts of one currency. An empty list is zero in currency c.
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
