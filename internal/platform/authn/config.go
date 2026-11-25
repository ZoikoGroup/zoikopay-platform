package authn

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

// ErrConfig is returned for verifier configuration that is missing or unsafe.
var ErrConfig = errors.New("authn: invalid configuration")

// Config describes one trusted token issuer. Nothing in it is specific to a
// product: Keycloak (the local Zoiko iD stand-in) and any other OIDC issuer
// differ only in these values (03-05 §7.1, 02-02 §2.2).
//
// Keycloak realm "zoikopay" (local):
//
//	Issuer:         http://localhost:8180/realms/zoikopay
//	JWKSURL:        http://localhost:8180/realms/zoikopay/protocol/openid-connect/certs
//	RequiredClaims: {"typ": "Bearer"}   // refuse Keycloak ID and refresh tokens
type Config struct {
	// Issuer must equal the token's iss exactly.
	Issuer string
	// Audience must be one of the token's aud values: the API this verifier
	// protects, so a token minted for another API is refused (03-05 "token from
	// another audience ... is honored" is a listed failure).
	Audience string
	// JWKSURL serves the issuer's public signing keys.
	JWKSURL string
	// Algorithms accepted in the token header. Default RS256, PS256, ES256.
	// Only asymmetric algorithms are allowed: never "none" or HS*.
	Algorithms []string
	// RequiredClaims must be present with exactly these string values, e.g.
	// {"typ": "Bearer"} for Keycloak access tokens.
	RequiredClaims map[string]string
	// SessionIDClaim names the session claim copied into Identity.SessionID.
	// Default "sid" (OpenID Connect); some issuers use "session_id".
	SessionIDClaim string
	// Leeway allowed on exp, nbf and iat for clock skew. Default 30s, at most 2m.
	Leeway time.Duration
	// MaxLifetime caps exp - iat, so a long-lived token is refused even if its
	// signature is valid. Default 1h.
	MaxLifetime time.Duration
	// AllowInsecureHTTP permits http:// issuer and JWKS URLs on hosts other
	// than loopback (for example a container name in local Docker). Never in
	// production. Loopback (localhost, 127.0.0.1, ::1) is always allowed.
	AllowInsecureHTTP bool

	// KeyCacheTTL is how long fetched keys are used before a refresh. Default 10m.
	KeyCacheTTL time.Duration
	// KeyRefreshInterval is the minimum time between two JWKS fetches, so
	// tokens with made-up key IDs cannot make the verifier hammer the issuer.
	// Default 1m.
	KeyRefreshInterval time.Duration
	// KeyMaxStale is how long the last good keys may still be used while the
	// JWKS endpoint is failing. Default 1h; after that, verification fails closed.
	KeyMaxStale time.Duration

	// HTTPClient fetches the JWKS. Default: a client with a 5s timeout.
	HTTPClient *http.Client
	// Now is the clock (tests). Default time.Now.
	Now func() time.Time
}

// Defaults and limits.
const (
	DefaultLeeway             = 30 * time.Second
	MaxLeeway                 = 2 * time.Minute
	DefaultMaxLifetime        = time.Hour
	DefaultKeyCacheTTL        = 10 * time.Minute
	DefaultKeyRefreshInterval = time.Minute
	DefaultKeyMaxStale        = time.Hour
	DefaultSessionIDClaim     = "sid"
)

var (
	defaultAlgorithms = []string{string(jose.RS256), string(jose.PS256), string(jose.ES256)}
	// asymmetricAlgorithms are the only algorithms Config may name.
	asymmetricAlgorithms = []string{
		string(jose.RS256), string(jose.RS384), string(jose.RS512),
		string(jose.PS256), string(jose.PS384), string(jose.PS512),
		string(jose.ES256), string(jose.ES384), string(jose.ES512),
		string(jose.EdDSA),
	}
)

// withDefaults returns a copy of c with defaults filled in, or an error if c
// is missing a required value or would weaken verification.
func (c Config) withDefaults() (Config, error) {
	if c.Issuer == "" || c.Audience == "" || c.JWKSURL == "" {
		return c, fmt.Errorf("%w: issuer, audience and JWKS URL are required", ErrConfig)
	}
	if err := checkURL("issuer", c.Issuer, c.AllowInsecureHTTP); err != nil {
		return c, err
	}
	if err := checkURL("JWKS URL", c.JWKSURL, c.AllowInsecureHTTP); err != nil {
		return c, err
	}
	if len(c.Algorithms) == 0 {
		c.Algorithms = slices.Clone(defaultAlgorithms)
	}
	for _, a := range c.Algorithms {
		if !slices.Contains(asymmetricAlgorithms, a) {
			return c, fmt.Errorf("%w: algorithm %q is not allowed (asymmetric algorithms only)", ErrConfig, a)
		}
	}
	for k, v := range c.RequiredClaims {
		if k == "" || v == "" {
			return c, fmt.Errorf("%w: required claims need a name and a value", ErrConfig)
		}
	}
	if c.SessionIDClaim == "" {
		c.SessionIDClaim = DefaultSessionIDClaim
	}
	if c.Leeway == 0 {
		c.Leeway = DefaultLeeway
	}
	if c.Leeway < 0 || c.Leeway > MaxLeeway {
		return c, fmt.Errorf("%w: leeway must be between 0 and %s", ErrConfig, MaxLeeway)
	}
	if c.MaxLifetime == 0 {
		c.MaxLifetime = DefaultMaxLifetime
	}
	if c.KeyCacheTTL == 0 {
		c.KeyCacheTTL = DefaultKeyCacheTTL
	}
	if c.KeyRefreshInterval == 0 {
		c.KeyRefreshInterval = DefaultKeyRefreshInterval
	}
	if c.KeyMaxStale == 0 {
		c.KeyMaxStale = DefaultKeyMaxStale
	}
	if c.MaxLifetime < 0 || c.KeyCacheTTL < 0 || c.KeyRefreshInterval < 0 || c.KeyMaxStale < c.KeyCacheTTL {
		return c, fmt.Errorf("%w: durations must be positive and KeyMaxStale at least KeyCacheTTL", ErrConfig)
	}
	if c.HTTPClient == nil {
		c.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c, nil
}

func checkURL(what, raw string, allowInsecure bool) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return fmt.Errorf("%w: %s %q is not an absolute URL", ErrConfig, what, raw)
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if allowInsecure || isLoopback(u.Hostname()) {
			return nil
		}
		return fmt.Errorf("%w: %s %q must use https (http only on loopback, or with AllowInsecureHTTP)", ErrConfig, what, raw)
	default:
		return fmt.Errorf("%w: %s %q must use https", ErrConfig, what, raw)
	}
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Environment variables read by ConfigFromEnv.
const (
	EnvIssuer            = "ZP_OIDC_ISSUER"
	EnvAudience          = "ZP_OIDC_AUDIENCE"
	EnvJWKSURL           = "ZP_OIDC_JWKS_URL"
	EnvAlgorithms        = "ZP_OIDC_ALGORITHMS"         // comma separated, e.g. RS256,ES256
	EnvRequiredClaims    = "ZP_OIDC_REQUIRED_CLAIMS"    // comma separated name=value, e.g. typ=Bearer
	EnvSessionIDClaim    = "ZP_OIDC_SESSION_ID_CLAIM"   // e.g. sid
	EnvLeeway            = "ZP_OIDC_LEEWAY"             // Go duration, e.g. 30s
	EnvMaxLifetime       = "ZP_OIDC_MAX_TOKEN_LIFETIME" // Go duration, e.g. 1h
	EnvAllowInsecureHTTP = "ZP_OIDC_ALLOW_INSECURE_HTTP"
)

// ConfigFromEnv reads a Config from ZP_OIDC_* environment variables. Only
// public values are read: the verifier needs no client secret.
func ConfigFromEnv() (Config, error) {
	return configFromLookup(os.LookupEnv)
}

func configFromLookup(lookup func(string) (string, bool)) (Config, error) {
	get := func(name string) string { v, _ := lookup(name); return strings.TrimSpace(v) }
	c := Config{
		Issuer:         get(EnvIssuer),
		Audience:       get(EnvAudience),
		JWKSURL:        get(EnvJWKSURL),
		SessionIDClaim: get(EnvSessionIDClaim),
	}
	if v := get(EnvAlgorithms); v != "" {
		for a := range strings.SplitSeq(v, ",") {
			c.Algorithms = append(c.Algorithms, strings.TrimSpace(a))
		}
	}
	if v := get(EnvRequiredClaims); v != "" {
		c.RequiredClaims = map[string]string{}
		for pair := range strings.SplitSeq(v, ",") {
			name, value, ok := strings.Cut(strings.TrimSpace(pair), "=")
			if !ok {
				return c, fmt.Errorf("%w: %s entry %q is not name=value", ErrConfig, EnvRequiredClaims, pair)
			}
			c.RequiredClaims[strings.TrimSpace(name)] = strings.TrimSpace(value)
		}
	}
	for name, dst := range map[string]*time.Duration{EnvLeeway: &c.Leeway, EnvMaxLifetime: &c.MaxLifetime} {
		if v := get(name); v != "" {
			d, err := time.ParseDuration(v)
			if err != nil || d <= 0 {
				return c, fmt.Errorf("%w: %s=%q is not a positive duration", ErrConfig, name, v)
			}
			*dst = d
		}
	}
	switch v := strings.ToLower(get(EnvAllowInsecureHTTP)); v {
	case "", "false", "0":
	case "true", "1":
		c.AllowInsecureHTTP = true
	default:
		return c, fmt.Errorf("%w: %s=%q is not true or false", ErrConfig, EnvAllowInsecureHTTP, v)
	}
	_, err := c.withDefaults() // report problems at start-up, not on the first request
	return c, err
}
