package money

import (
	"errors"
	"fmt"
	"math/big"
	"strings"
)

// ErrRoundingPolicyRequired means a result is not a whole number of minor
// units. No rounding policy is approved yet (02-05 §2.3 requires a versioned,
// approved RoundingPolicy), so the operation must be blocked, never rounded.
// Module 1 decision 5; OPEN_QUESTIONS Q28.
var ErrRoundingPolicyRequired = errors.New("result needs rounding and no rounding policy is approved")

// MulDivExact returns m × num ÷ den using exact integer arithmetic (no
// floats, no intermediate overflow). It fails with ErrRoundingPolicyRequired
// when the result has a fractional minor unit, and ErrOverflow when it does
// not fit. Use it for percentages, fees and allocations; it never rounds.
func MulDivExact(m Money, num, den int64) (Money, error) {
	if den == 0 {
		return Money{}, errors.New("money: division by zero")
	}
	p := new(big.Int).Mul(big.NewInt(int64(m.Amount)), big.NewInt(num))
	q, r := new(big.Int).QuoRem(p, big.NewInt(den), new(big.Int))
	if r.Sign() != 0 {
		return Money{}, fmt.Errorf("%w: %s × %d ÷ %d", ErrRoundingPolicyRequired, m, num, den)
	}
	if !q.IsInt64() || q.Int64() == -1<<63 {
		return Money{}, fmt.Errorf("%w: %s × %d ÷ %d", ErrOverflow, m, num, den)
	}
	return Money{Amount: Minor(q.Int64()), Currency: m.Currency}, nil
}

// TransactionAmountCheckSQL returns a column CHECK enforcing the provisional
// per-transaction limit on a BIGINT amount column. Do not use it on balance
// or total columns.
func TransactionAmountCheckSQL(column string) string {
	return fmt.Sprintf("CHECK (%s BETWEEN %d AND %d)", column, -MaxTransactionMinor, MaxTransactionMinor)
}

// CurrencyCheckSQL returns a column CHECK limiting a currency column to the
// registry. Adding a currency is a registry change (new SpecVersion) and a
// migration, which is intended: both need approval (02-05 §2).
func CurrencyCheckSQL(column string) string {
	codes := make([]string, 0, len(registry))
	for _, c := range Currencies() {
		codes = append(codes, "'"+string(c)+"'")
	}
	return fmt.Sprintf("CHECK (%s IN (%s))", column, strings.Join(codes, ", "))
}
