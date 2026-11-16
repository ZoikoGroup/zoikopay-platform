// Package money is the shared Money type: int64 minor units plus an ISO 4217
// currency, encoded as a decimal string on the wire (ADR 0001 §3). Never floats.
//
// Rules (02-05):
//   - amount_minor is a JSON string holding a base-10 signed integer, for
//     example "1999". JSON numbers, fractions, exponents, "+", leading zeros
//     and "-0" are rejected.
//   - every amount carries a currency from the registry; an unknown or
//     inactive currency fails closed (no guessed exponent).
//   - arithmetic only combines the same currency and fails on overflow or on
//     leaving the allowed range; it never rounds.
//
// The currency registry is versioned (SpecVersion). Per OPEN_QUESTIONS Q3 the
// version is stored with each intent but not sent on the wire in the pilot.
package money
