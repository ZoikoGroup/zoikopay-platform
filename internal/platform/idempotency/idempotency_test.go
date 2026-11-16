package idempotency_test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"

	"github.com/zoiko/zoikopay/internal/platform/idempotency"
)

func TestParseHeader(t *testing.T) {
	const k = "8e03978e-40d5-43e8-bc93-6894a57f9324"
	got, err := idempotency.ParseHeader([]string{`"` + k + `"`})
	if err != nil || string(got) != k {
		t.Fatalf("valid key: %q, %v", got, err)
	}
	if got, _ := idempotency.ParseHeader([]string{`"8E03978E-40D5-43E8-BC93-6894A57F9324"`}); string(got) != k {
		t.Fatalf("upper-case UUID should normalize, got %q", got)
	}

	cases := map[string]struct {
		in   []string
		want error
	}{
		"missing":     {nil, idempotency.ErrKeyMissing},
		"empty":       {[]string{"  "}, idempotency.ErrKeyMissing},
		"repeated":    {[]string{`"` + k + `"`, `"` + k + `"`}, idempotency.ErrKeyRepeated},
		"list":        {[]string{`"` + k + `", "` + k + `"`}, idempotency.ErrKeyRepeated},
		"unquoted":    {[]string{k}, idempotency.ErrKeyMalformed},
		"not a uuid":  {[]string{`"order-123"`}, idempotency.ErrKeyMalformed},
		"no dashes":   {[]string{`"8e03978e40d543e8bc936894a57f93240000"`}, idempotency.ErrKeyMalformed},
		"bad hex":     {[]string{`"ze03978e-40d5-43e8-bc93-6894a57f9324"`}, idempotency.ErrKeyMalformed},
		"half quoted": {[]string{`"` + k}, idempotency.ErrKeyMalformed},
	}
	for name, c := range cases {
		if _, err := idempotency.ParseHeader(c.in); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v; want %v", name, err, c.want)
		}
	}
}

func TestKeyNeverAppearsInLogs(t *testing.T) {
	k, _ := idempotency.ParseHeader([]string{`"8e03978e-40d5-43e8-bc93-6894a57f9324"`})
	if s := k.String(); bytes.Contains([]byte(s), []byte("8e03978e")) {
		t.Fatalf("String() leaks the key: %s", s)
	}
	if len(k.Digest()) != 32 {
		t.Fatal("digest must be SHA-256")
	}
}

// RFC 8785 §3.2.2 / appendix examples that fall within our supported types.
func TestCanonicalizeMatchesRFC8785(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{map[string]any{"b": 1, "a": "x", "c": nil, "d": true}, `{"a":"x","b":1,"c":null,"d":true}`},
		{map[string]any{"z": []any{3, "b", map[string]any{"y": 1, "x": 2}}}, `{"z":[3,"b",{"x":2,"y":1}]}`},
		// String escaping: only " \ and control characters; "/" and non-ASCII stay literal.
		{"€$\u000f\nA'B\"\\\\\"/", `"€$\u000f\nA'B\"\\\\\"/"`},
		{"\u0080\u07ff\uffff", "\"\u0080\u07ff\uffff\""},
		// Keys sort by UTF-16 code units (RFC 8785 §3.2.3 example subset).
		{map[string]any{"\u20ac": "Euro Sign", "\r": "Carriage Return", "\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One", "\U0001f600": "Emoji: Grinning Face", "\u0080": "Control", "\u00f6": "Latin Small Letter O With Diaeresis"},
			"{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\u0080\":\"Control\",\"\u00f6\":\"Latin Small Letter O With Diaeresis\",\"\u20ac\":\"Euro Sign\",\"\U0001f600\":\"Emoji: Grinning Face\",\"\ufb33\":\"Hebrew Letter Dalet With Dagesh\"}"},
		{json.Number("-42"), `-42`},
		{[]any{}, `[]`},
		{map[string]any{}, `{}`},
	}
	for _, c := range cases {
		got, err := idempotency.Canonicalize(c.in)
		if err != nil || string(got) != c.want {
			t.Errorf("Canonicalize(%#v)\n got  %s (%v)\n want %s", c.in, got, err, c.want)
		}
	}
	for _, bad := range []any{json.Number("1.5"), json.Number("1e3"), int64(1 << 53), 3.14, struct{}{}, "\xff"} {
		if _, err := idempotency.Canonicalize(bad); !errors.Is(err, idempotency.ErrNotCanonicalizable) {
			t.Errorf("Canonicalize(%#v) err = %v", bad, err)
		}
	}
}

func TestFingerprint(t *testing.T) {
	base := idempotency.Input{
		OperationKind: "payment_intent.create", Method: "POST", Route: "/v1/payment_intents",
		Body: map[string]any{"amount_minor": "1999", "currency": "GBP", "capture_method": "manual"},
	}
	fp := func(in idempotency.Input) string {
		b, err := idempotency.Fingerprint(in)
		if err != nil {
			t.Fatal(err)
		}
		return hex.EncodeToString(b)
	}
	a := fp(base)

	// Key order is not economic intent.
	reordered := base
	reordered.Body = map[string]any{"capture_method": "manual", "currency": "GBP", "amount_minor": "1999"}
	if fp(reordered) != a {
		t.Fatal("member order must not change the fingerprint")
	}
	// Any economic change does.
	for name, body := range map[string]map[string]any{
		"amount":         {"amount_minor": "2000", "currency": "GBP", "capture_method": "manual"},
		"currency":       {"amount_minor": "1999", "currency": "EUR", "capture_method": "manual"},
		"capture":        {"amount_minor": "1999", "currency": "GBP", "capture_method": "automatic"},
		"null vs absent": {"amount_minor": "1999", "currency": "GBP", "capture_method": "manual", "metadata": nil},
	} {
		changed := base
		changed.Body = body
		if fp(changed) == a {
			t.Errorf("%s change must change the fingerprint", name)
		}
	}
	otherRoute := base
	otherRoute.Route = "/v1/payment_intents/{id}/capture"
	if fp(otherRoute) == a {
		t.Error("route must be part of the fingerprint")
	}
}
