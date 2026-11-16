// Package money is the shared Money type: int64 minor units plus an ISO 4217
// currency, encoded as a decimal string on the wire (ADR 0001 §3). Never floats.
//
// Rules (02-05; Module 1 decisions 4 and 5, ADR 0005 §3):
//   - amount_minor is a JSON string holding a base-10 signed integer, for
//     example "1999". JSON numbers, fractions, exponents, "+", leading zeros
//     and "-0" are rejected.
//   - every amount carries a currency from the versioned registry; an
//     unknown currency fails closed (no guessed exponent).
//   - one transaction amount is limited to 15 digits (MaxTransactionMinor,
//     provisional, OPEN_QUESTIONS Q26): use ParseTransaction /
//     ValidateTransaction. Balances and totals are not limited; they are
//     only protected against int64 overflow (ErrOverflow).
//   - arithmetic only combines the same currency and never rounds. No
//     rounding policy is approved, so a result with a fractional minor unit
//     fails with ErrRoundingPolicyRequired and the posting must be blocked.
//
// The registry version (SpecVersion) is stored with each intent but not sent
// on the wire in the pilot (OPEN_QUESTIONS Q3).
package money
