package money

import (
	"encoding/json"
	"fmt"
	"sort"
)

// SpecVersion identifies this currency registry revision (02-05 §2:
// currency_spec_version). Changing an exponent requires a new version.
const SpecVersion = "iso-2026-11-r1"

// Currency is an ISO 4217 alphabetic code that is in the registry.
type Currency string

// CurrencySpec is one registry entry (02-05 §2).
type CurrencySpec struct {
	Code Currency
	// ISOExponent is the number of minor-unit digits (GBP 2, JPY 0, BHD 3).
	ISOExponent int
}

// registry lists the currencies the platform accepts. The pilot currency is
// not chosen yet (OPEN_QUESTIONS Q8), so this holds the currencies the specs
// and console use. Provider-specific exponents belong to each connector
// (02-05: never rescale by guessing).
var registry = map[Currency]CurrencySpec{
	"GBP": {Code: "GBP", ISOExponent: 2},
	"EUR": {Code: "EUR", ISOExponent: 2},
	"USD": {Code: "USD", ISOExponent: 2},
}

// ParseCurrency accepts an exact, upper-case code from the registry.
func ParseCurrency(s string) (Currency, error) {
	c := Currency(s)
	if _, ok := registry[c]; !ok {
		return "", fmt.Errorf("%w: %q", ErrCurrency, s)
	}
	return c, nil
}

// Spec returns the registry entry for c.
func (c Currency) Spec() (CurrencySpec, error) {
	s, ok := registry[c]
	if !ok {
		return CurrencySpec{}, fmt.Errorf("%w: %q", ErrCurrency, string(c))
	}
	return s, nil
}

// UnmarshalJSON accepts only registry codes.
func (c *Currency) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("%w: currency must be a string", ErrCurrency)
	}
	v, err := ParseCurrency(s)
	if err != nil {
		return err
	}
	*c = v
	return nil
}

// Currencies returns the supported codes in sorted order.
func Currencies() []Currency {
	out := make([]Currency, 0, len(registry))
	for c := range registry {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
