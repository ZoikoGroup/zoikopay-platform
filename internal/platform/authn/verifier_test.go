package authn_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"github.com/zoiko/zoikopay/internal/platform/authn"
)

// The test issuer stands in for any OIDC provider (Keycloak locally). Its
// issuer URL is never contacted; only the JWKS URL is, and that is httptest.
const (
	issuerURL = "https://issuer.example.test/realms/zoikopay"
	audience  = "zoikopay-gateway"
	subject   = "00000000-0000-4000-8000-000000000002"
)

var t0 = time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)

type testIssuer struct {
	t      *testing.T
	srv    *httptest.Server
	hits   atomic.Int32
	mu     sync.Mutex
	keys   []jose.JSONWebKey // served as the JWKS
	status int
	rsa    *rsa.PrivateKey   // kid rsa-1, alg RS256
	ec     *ecdsa.PrivateKey // kid ec-1, alg ES256
	now    time.Time
}

func newIssuer(t *testing.T) *testIssuer {
	t.Helper()
	is := &testIssuer{t: t, status: http.StatusOK, now: t0, rsa: rsaKey(t), ec: ecKey(t)}
	is.keys = []jose.JSONWebKey{
		{Key: is.rsa.Public(), KeyID: "rsa-1", Algorithm: "RS256", Use: "sig"},
		{Key: is.ec.Public(), KeyID: "ec-1", Algorithm: "ES256", Use: "sig"},
	}
	is.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		is.hits.Add(1)
		is.mu.Lock()
		defer is.mu.Unlock()
		if is.status != http.StatusOK {
			w.WriteHeader(is.status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: is.keys})
	}))
	t.Cleanup(is.srv.Close)
	return is
}

func (is *testIssuer) setKeys(keys ...jose.JSONWebKey) {
	is.mu.Lock()
	defer is.mu.Unlock()
	is.keys = keys
}

func (is *testIssuer) setStatus(code int) {
	is.mu.Lock()
	defer is.mu.Unlock()
	is.status = code
}

// config is what a deployment would set for this issuer, including the
// Keycloak-style rule that only access tokens (typ=Bearer) are accepted.
func (is *testIssuer) config() authn.Config {
	return authn.Config{
		Issuer: issuerURL, Audience: audience, JWKSURL: is.srv.URL + "/protocol/openid-connect/certs",
		RequiredClaims: map[string]string{"typ": "Bearer"},
		Now:            func() time.Time { return is.now },
	}
}

func (is *testIssuer) verifier() *authn.Verifier {
	is.t.Helper()
	v, err := authn.NewVerifier(is.config())
	if err != nil {
		is.t.Fatal(err)
	}
	return v
}

// claims returns a valid access-token payload at the issuer's current time.
func (is *testIssuer) claims() map[string]any {
	return map[string]any{
		"iss": issuerURL, "aud": audience, "sub": subject, "typ": "Bearer",
		"iat": is.now.Add(-10 * time.Second).Unix(), "exp": is.now.Add(5 * time.Minute).Unix(),
		"auth_time": is.now.Add(-20 * time.Second).Unix(), "sid": "session-1", "jti": "token-1",
	}
}

func sign(t *testing.T, alg jose.SignatureAlgorithm, key any, kid string, claims map[string]any, opts ...func(*jose.SignerOptions)) string {
	t.Helper()
	o := (&jose.SignerOptions{}).WithType("JWT")
	if kid != "" {
		o = o.WithHeader("kid", kid)
	}
	for _, f := range opts {
		f(o)
	}
	s, err := jose.NewSigner(jose.SigningKey{Algorithm: alg, Key: key}, o)
	if err != nil {
		t.Fatal(err)
	}
	tok, err := jwt.Signed(s).Claims(claims).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func (is *testIssuer) rsaToken(claims map[string]any) string {
	return sign(is.t, jose.RS256, is.rsa, "rsa-1", claims)
}

func rsaKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func ecKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func wantInvalid(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, authn.ErrInvalidToken) {
		t.Errorf("%s: err = %v; want ErrInvalidToken", what, err)
	}
}

func TestVerifyAcceptsValidAccessTokens(t *testing.T) {
	is := newIssuer(t)
	v := is.verifier()
	ctx := context.Background()

	for name, tok := range map[string]string{
		"RS256": is.rsaToken(is.claims()),
		"ES256": sign(t, jose.ES256, is.ec, "ec-1", is.claims()),
	} {
		id, err := v.Verify(ctx, tok)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		want := authn.Identity{
			Issuer: issuerURL, Subject: subject, Audience: []string{audience},
			IssuedAt: t0.Add(-10 * time.Second), ExpiresAt: t0.Add(5 * time.Minute),
			AuthTime: t0.Add(-20 * time.Second), SessionID: "session-1", TokenID: "token-1",
		}
		if !reflect.DeepEqual(id, want) {
			t.Errorf("%s: identity = %+v; want %+v", name, id, want)
		}
	}

	// aud may be a list (Keycloak adds "account"); ours must be in it.
	c := is.claims()
	c["aud"] = []string{"account", audience}
	if _, err := v.Verify(ctx, is.rsaToken(c)); err != nil {
		t.Errorf("audience list containing ours: %v", err)
	}
	// Within the 30s leeway.
	c = is.claims()
	c["exp"] = t0.Add(-20 * time.Second).Unix()
	c["iat"] = t0.Add(-5 * time.Minute).Unix()
	if _, err := v.Verify(ctx, is.rsaToken(c)); err != nil {
		t.Errorf("expired 20s ago, within leeway: %v", err)
	}
}

func TestVerifyRefusesWrongClaims(t *testing.T) {
	is := newIssuer(t)
	v := is.verifier()
	for name, mutate := range map[string]func(map[string]any){
		"another issuer":                    func(c map[string]any) { c["iss"] = "https://evil.example.test/realms/zoikopay" },
		"issuer with a trailing slash":      func(c map[string]any) { c["iss"] = issuerURL + "/" },
		"another audience":                  func(c map[string]any) { c["aud"] = "another-api" },
		"no audience":                       func(c map[string]any) { delete(c, "aud") },
		"no subject":                        func(c map[string]any) { delete(c, "sub") },
		"empty subject":                     func(c map[string]any) { c["sub"] = "" },
		"subject over 255 characters":       func(c map[string]any) { c["sub"] = strings.Repeat("s", 256) },
		"expired beyond the leeway":         func(c map[string]any) { c["exp"] = t0.Add(-31 * time.Second).Unix() },
		"no expiry":                         func(c map[string]any) { delete(c, "exp") },
		"no issued-at":                      func(c map[string]any) { delete(c, "iat") },
		"issued in the future":              func(c map[string]any) { c["iat"] = t0.Add(time.Minute).Unix() },
		"not valid yet":                     func(c map[string]any) { c["nbf"] = t0.Add(time.Minute).Unix() },
		"lifetime over one hour":            func(c map[string]any) { c["exp"] = t0.Add(2 * time.Hour).Unix() },
		"Keycloak ID token (typ=ID)":        func(c map[string]any) { c["typ"] = "ID" },
		"Keycloak refresh token":            func(c map[string]any) { c["typ"] = "Refresh" },
		"no token type":                     func(c map[string]any) { delete(c, "typ") },
		"token type of the wrong JSON type": func(c map[string]any) { c["typ"] = true },
	} {
		c := is.claims()
		mutate(c)
		_, err := v.Verify(context.Background(), is.rsaToken(c))
		wantInvalid(t, name, err)
	}
}

func TestVerifyRefusesForgedAndUnsafeTokens(t *testing.T) {
	is := newIssuer(t)
	v := is.verifier()
	attacker := rsaKey(t)
	good := is.rsaToken(is.claims())
	parts := strings.Split(good, ".")
	b64 := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	pubDER, _ := x509.MarshalPKIXPublicKey(is.rsa.Public())

	tampered := is.claims()
	tampered["sub"] = "someone-else"

	for name, tok := range map[string]string{
		"empty":     "",
		"garbage":   "not.a.jwt",
		"too large": strings.Repeat("a", 9000),
		"alg none":  b64(map[string]string{"alg": "none", "kid": "rsa-1"}) + "." + parts[1] + ".",
		// Key confusion: HMAC "signed" with the issuer's public key bytes.
		"HS256 with the public key as secret":    sign(t, jose.HS256, pubDER, "rsa-1", is.claims()),
		"signed by another key under our key ID": sign(t, jose.RS256, attacker, "rsa-1", is.claims()),
		"payload swapped after signing":          parts[0] + "." + strings.Split(is.rsaToken(tampered), ".")[1] + "." + parts[2],
		"no key ID":                              sign(t, jose.RS256, is.rsa, "", is.claims()),
		"unknown key ID":                         sign(t, jose.RS256, is.rsa, "rsa-9", is.claims()),
		"embedded attacker key":                  sign(t, jose.RS256, attacker, "rsa-1", is.claims(), func(o *jose.SignerOptions) { o.EmbedJWK = true }),
		// Correctly signed, but carrying a key: refused on principle, since
		// keys come only from the configured JWKS.
		"embedded key, even the issuer's own": sign(t, jose.RS256, is.rsa, "rsa-1", is.claims(), func(o *jose.SignerOptions) { o.EmbedJWK = true }),
		// The JWKS says rsa-1 is for RS256 only.
		"PS256 with an RS256 key": sign(t, jose.PS256, is.rsa, "rsa-1", is.claims()),
		"RS512 (not configured)":  sign(t, jose.RS512, is.rsa, "rsa-1", is.claims()),
	} {
		_, err := v.Verify(context.Background(), tok)
		wantInvalid(t, name, err)
	}
}

// Identity must never grow fields that look like authority: tenant, role and
// merchant come from Zoiko Pay's membership records, not the token.
func TestIdentityCarriesNoAuthorityClaims(t *testing.T) {
	is := newIssuer(t)
	c := is.claims()
	c["tenant_id"] = "ten_forged"
	c["roles"] = []string{"SUPER_ADMIN"}
	c["user_metadata"] = map[string]any{"tenant_id": "ten_forged", "role": "MOWN"}
	c["app_metadata"] = map[string]any{"merchant_id": "mer_forged"}
	if _, err := is.verifier().Verify(context.Background(), is.rsaToken(c)); err != nil {
		t.Fatalf("extra claims must not break verification: %v", err)
	}
	var fields []string
	typ := reflect.TypeFor[authn.Identity]()
	for i := range typ.NumField() {
		fields = append(fields, typ.Field(i).Name)
	}
	want := []string{"Issuer", "Subject", "Audience", "IssuedAt", "ExpiresAt", "AuthTime", "SessionID", "TokenID"}
	if !slices.Equal(fields, want) {
		t.Errorf("Identity fields = %v; want exactly %v (no roles, tenant or custom claims)", fields, want)
	}
}

func TestKeyCacheRotationAndRefreshLimit(t *testing.T) {
	is := newIssuer(t)
	v := is.verifier()
	ctx := context.Background()
	verify := func(tok string) error { _, err := v.Verify(ctx, tok); return err }

	if err := verify(is.rsaToken(is.claims())); err != nil {
		t.Fatal(err)
	}
	if err := verify(is.rsaToken(is.claims())); err != nil || is.hits.Load() != 1 {
		t.Fatalf("second token: err %v, %d fetches; want the cached keys (1 fetch)", err, is.hits.Load())
	}

	// Made-up key IDs must not trigger a fetch each.
	for i := range 20 {
		wantInvalid(t, "unknown kid", verify(sign(t, jose.RS256, is.rsa, "made-up-"+string(rune('a'+i)), is.claims())))
	}
	if n := is.hits.Load(); n != 1 {
		t.Errorf("20 unknown key IDs within the refresh interval caused %d fetches; want 1", n)
	}

	// The issuer rotates: a new key appears. After the refresh interval, a
	// token with the new key ID triggers exactly one fetch and verifies.
	next := rsaKey(t)
	is.setKeys(jose.JSONWebKey{Key: next.Public(), KeyID: "rsa-2", Algorithm: "RS256", Use: "sig"})
	is.now = is.now.Add(61 * time.Second)
	if err := verify(sign(t, jose.RS256, next, "rsa-2", is.claims())); err != nil {
		t.Fatalf("token with the rotated key: %v", err)
	}
	if n := is.hits.Load(); n != 2 {
		t.Errorf("rotation caused %d fetches in total; want 2", n)
	}
	// The retired key is gone from the issuer's JWKS, so it is refused.
	wantInvalid(t, "retired key", verify(is.rsaToken(is.claims())))

	// After the cache TTL (10m) keys are refreshed even for a known key ID.
	is.now = is.now.Add(11 * time.Minute)
	if err := verify(sign(t, jose.RS256, next, "rsa-2", is.claims())); err != nil {
		t.Fatal(err)
	}
	if n := is.hits.Load(); n != 3 {
		t.Errorf("after the TTL: %d fetches; want 3", n)
	}
}

func TestKeysUnavailableFailsClosed(t *testing.T) {
	is := newIssuer(t)
	v := is.verifier()
	ctx := context.Background()
	verify := func() error { _, err := v.Verify(ctx, is.rsaToken(is.claims())); return err }

	is.setStatus(http.StatusInternalServerError)
	if err := verify(); !errors.Is(err, authn.ErrKeysUnavailable) {
		t.Fatalf("JWKS down at start: %v; want ErrKeysUnavailable", err)
	}
	is.setStatus(http.StatusOK)
	if err := verify(); !errors.Is(err, authn.ErrKeysUnavailable) {
		t.Errorf("retry inside the refresh interval: %v; want ErrKeysUnavailable without a new fetch", err)
	}
	is.now = is.now.Add(61 * time.Second)
	if err := verify(); err != nil {
		t.Fatalf("JWKS back: %v", err)
	}

	// The issuer fails again. The last good keys serve until KeyMaxStale (1h).
	is.setStatus(http.StatusServiceUnavailable)
	is.now = is.now.Add(11 * time.Minute)
	if err := verify(); err != nil {
		t.Errorf("stale keys within the limit: %v; want them still used", err)
	}
	is.now = is.now.Add(time.Hour)
	if err := verify(); !errors.Is(err, authn.ErrKeysUnavailable) {
		t.Errorf("keys older than the limit: %v; want ErrKeysUnavailable", err)
	}
}

func TestJWKSKeepsOnlyPublicSigningKeys(t *testing.T) {
	is := newIssuer(t)
	priv, enc, dup := rsaKey(t), rsaKey(t), rsaKey(t)
	is.setKeys(
		jose.JSONWebKey{Key: is.rsa.Public(), KeyID: "rsa-1", Algorithm: "RS256", Use: "sig"},
		jose.JSONWebKey{Key: []byte("shared-secret-of-32-bytes-long!!"), KeyID: "sym", Algorithm: "HS256"},
		jose.JSONWebKey{Key: priv, KeyID: "private", Algorithm: "RS256"}, // a private key published by mistake
		jose.JSONWebKey{Key: enc.Public(), KeyID: "enc", Use: "enc"},
		jose.JSONWebKey{Key: dup.Public(), KeyID: "dup", Algorithm: "RS256"},
		jose.JSONWebKey{Key: is.ec.Public(), KeyID: "dup", Algorithm: "ES256"},
		jose.JSONWebKey{Key: is.ec.Public(), Algorithm: "ES256"}, // no key ID
	)
	v := is.verifier()
	ctx := context.Background()
	if _, err := v.Verify(ctx, is.rsaToken(is.claims())); err != nil {
		t.Fatalf("the good key must still work: %v", err)
	}
	for name, tok := range map[string]string{
		"private key entry":     sign(t, jose.RS256, priv, "private", is.claims()),
		"encryption-only key":   sign(t, jose.RS256, enc, "enc", is.claims()),
		"key ID listed twice":   sign(t, jose.RS256, dup, "dup", is.claims()),
		"symmetric key (HS256)": sign(t, jose.HS256, []byte("shared-secret-of-32-bytes-long!!"), "sym", is.claims()),
	} {
		_, err := v.Verify(ctx, tok)
		wantInvalid(t, name, err)
	}
}

func TestNewVerifierRefusesUnsafeConfig(t *testing.T) {
	is := newIssuer(t)
	for name, mutate := range map[string]func(*authn.Config){
		"no issuer":        func(c *authn.Config) { c.Issuer = "" },
		"no audience":      func(c *authn.Config) { c.Audience = "" },
		"no JWKS URL":      func(c *authn.Config) { c.JWKSURL = "" },
		"HS256 allowed":    func(c *authn.Config) { c.Algorithms = []string{"RS256", "HS256"} },
		"alg none allowed": func(c *authn.Config) { c.Algorithms = []string{"none"} },
		"plain http on a remote host": func(c *authn.Config) {
			c.JWKSURL = "http://keycloak:8080/realms/zoikopay/protocol/openid-connect/certs"
		},
		"plain http issuer":           func(c *authn.Config) { c.Issuer = "http://idp.example.test/realms/zoikopay" },
		"not a URL":                   func(c *authn.Config) { c.Issuer = "zoikopay" },
		"credentials in the URL":      func(c *authn.Config) { c.JWKSURL = "https://user:pw@idp.example.test/certs" },
		"negative leeway":             func(c *authn.Config) { c.Leeway = -time.Second },
		"leeway over two minutes":     func(c *authn.Config) { c.Leeway = 3 * time.Minute },
		"empty required claim value":  func(c *authn.Config) { c.RequiredClaims = map[string]string{"typ": ""} },
		"stale limit below cache TTL": func(c *authn.Config) { c.KeyCacheTTL = time.Hour; c.KeyMaxStale = time.Minute },
	} {
		c := is.config()
		mutate(&c)
		if _, err := authn.NewVerifier(c); !errors.Is(err, authn.ErrConfig) {
			t.Errorf("%s: err = %v; want ErrConfig", name, err)
		}
	}

	c := is.config()
	c.JWKSURL = "http://keycloak:8080/realms/zoikopay/protocol/openid-connect/certs"
	c.AllowInsecureHTTP = true
	if _, err := authn.NewVerifier(c); err != nil {
		t.Errorf("explicit AllowInsecureHTTP for local Docker: %v", err)
	}
	c = is.config()
	c.Issuer = "http://localhost:8180/realms/zoikopay" // the local Keycloak realm
	if _, err := authn.NewVerifier(c); err != nil {
		t.Errorf("loopback http issuer: %v", err)
	}
}

func TestBearerToken(t *testing.T) {
	for _, c := range []struct {
		headers []string
		want    string
	}{
		{[]string{"Bearer abc.def.ghi"}, "abc.def.ghi"},
		{[]string{"bearer abc.def.ghi"}, "abc.def.ghi"},
		{nil, ""},
		{[]string{"Basic dXNlcjpwYXNz"}, ""},
		{[]string{"Bearer"}, ""},
		{[]string{"Bearer "}, ""},
		{[]string{"Bearer  abc"}, ""},
		{[]string{"Bearer abc def"}, ""},
		{[]string{"Bearer abc", "Bearer def"}, ""},
		{[]string{"Bearer " + strings.Repeat("a", 9000)}, ""},
	} {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/v1/merchants?access_token=from-query", nil)
		for _, h := range c.headers {
			r.Header.Add("Authorization", h)
		}
		got, err := authn.BearerToken(r)
		if c.want == "" {
			wantInvalid(t, strings.Join(c.headers, " | "), err)
		} else if err != nil || got != c.want {
			t.Errorf("%v: got %q, %v; want %q", c.headers, got, err, c.want)
		}
	}
}
