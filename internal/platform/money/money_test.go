package money_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/zoiko/zoikopay/internal/platform/money"
)

func TestParseMinorAcceptsStrictDecimals(t *testing.T) {
	for s, want := range map[string]money.Minor{
		"0": 0, "1": 1, "1999": 1999, "-1": -1, "-250": -250,
		"999999999999999": money.Minor(money.MaxMinor), "-999999999999999": -money.Minor(money.MaxMinor),
	} {
		got, err := money.ParseMinor(s)
		if err != nil || got != want {
			t.Errorf("ParseMinor(%q) = %d, %v; want %d", s, got, err, want)
		}
	}
}

func TestParseMinorRejectsEverythingElse(t *testing.T) {
	for _, s := range []string{
		"", "-", "-0", "+5", "01", "00", "1.0", "1.", ".5", "1e3", "1E3", " 1", "1 ", "0x10", "١٢", "1_000", "NaN", "Infinity",
	} {
		if _, err := money.ParseMinor(s); !errors.Is(err, money.ErrFormat) {
			t.Errorf("ParseMinor(%q) err = %v; want ErrFormat", s, err)
		}
	}
	for _, s := range []string{"1000000000000000", "-1000000000000000", "9223372036854775807", "99999999999999999999999"} {
		if _, err := money.ParseMinor(s); !errors.Is(err, money.ErrRange) {
			t.Errorf("ParseMinor(%q) err = %v; want ErrRange", s, err)
		}
	}
}

func TestJSONIsAStringAndNumbersAreRejected(t *testing.T) {
	m, err := money.New(1999, "GBP")
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"amount_minor":"1999","currency":"GBP"}` {
		t.Fatalf("marshal = %s", b)
	}

	var back money.Money
	if err := json.Unmarshal(b, &back); err != nil || back != m {
		t.Fatalf("round trip = %v, %v", back, err)
	}

	// ADR 0001 §3: JSON numbers for money are rejected, even whole ones.
	for _, in := range []string{
		`{"amount_minor":1999,"currency":"GBP"}`,
		`{"amount_minor":19.99,"currency":"GBP"}`,
		`{"amount_minor":"19.99","currency":"GBP"}`,
		`{"amount_minor":null,"currency":"GBP"}`,
		`{"currency":"GBP"}`,
		`{"amount_minor":true,"currency":"GBP"}`,
	} {
		var x money.Money
		if err := json.Unmarshal([]byte(in), &x); !errors.Is(err, money.ErrFormat) {
			t.Errorf("Unmarshal(%s) err = %v; want ErrFormat", in, err)
		}
	}
}

func TestUnknownCurrencyFailsClosed(t *testing.T) {
	for _, c := range []string{"", "gbp", "XXX", "GBPX", "JPY"} {
		if _, err := money.Parse("100", c); !errors.Is(err, money.ErrCurrency) {
			t.Errorf("Parse(100, %q) err = %v; want ErrCurrency", c, err)
		}
	}
	var x money.Money
	if err := json.Unmarshal([]byte(`{"amount_minor":"100","currency":"ABC"}`), &x); !errors.Is(err, money.ErrCurrency) {
		t.Errorf("unknown currency in JSON: %v", err)
	}
	if spec, err := money.Currency("GBP").Spec(); err != nil || spec.ISOExponent != 2 {
		t.Errorf("GBP spec = %+v, %v", spec, err)
	}
}

func TestArithmeticNeverMixesCurrenciesOrOverflows(t *testing.T) {
	gbp := func(v int64) money.Money { m, _ := money.New(v, "GBP"); return m }
	eur, _ := money.New(5, "EUR")

	if got, err := gbp(1999).Add(gbp(1)); err != nil || got != gbp(2000) {
		t.Errorf("Add = %v, %v", got, err)
	}
	if got, err := gbp(100).Sub(gbp(250)); err != nil || got != gbp(-150) {
		t.Errorf("Sub = %v, %v", got, err)
	}
	if _, err := gbp(1).Add(eur); !errors.Is(err, money.ErrCurrencyMismatch) {
		t.Errorf("GBP + EUR err = %v", err)
	}
	if _, err := gbp(money.MaxMinor).Add(gbp(1)); !errors.Is(err, money.ErrRange) {
		t.Errorf("overflow past MaxMinor err = %v", err)
	}
	if _, err := money.New(money.MaxMinor+1, "GBP"); !errors.Is(err, money.ErrRange) {
		t.Errorf("New beyond MaxMinor err = %v", err)
	}
	if c, err := gbp(1).Cmp(gbp(2)); err != nil || c != -1 {
		t.Errorf("Cmp = %d, %v", c, err)
	}
	total, err := money.Sum("GBP", gbp(1), gbp(2), gbp(3))
	if err != nil || total != gbp(6) {
		t.Errorf("Sum = %v, %v", total, err)
	}
	if _, err := money.Sum("GBP", gbp(1), eur); !errors.Is(err, money.ErrCurrencyMismatch) {
		t.Errorf("Sum mixed err = %v", err)
	}
}

func FuzzParseMinorRoundTrip(f *testing.F) {
	for _, s := range []string{"0", "1999", "-1", "01", "1e3", "-0"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		m, err := money.ParseMinor(s)
		if err != nil {
			return
		}
		if m.String() != s {
			t.Fatalf("accepted %q but formats as %q: not canonical", s, m.String())
		}
	})
}
