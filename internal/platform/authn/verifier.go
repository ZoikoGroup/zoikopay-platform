package authn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

var (
	// ErrInvalidToken means the token must be refused. The wrapped reason is
	// for logs only: callers answer 401 without detail.
	ErrInvalidToken = errors.New("authn: invalid token")
	// ErrKeysUnavailable means the issuer's keys could not be obtained, so
	// nothing can be verified (fail closed). Callers still refuse the request.
	ErrKeysUnavailable = errors.New("authn: signing keys unavailable")
)

func invalid(reason string) error { return fmt.Errorf("%w: %s", ErrInvalidToken, reason) }

// maxTokenBytes bounds the work done on an unauthenticated input.
const maxTokenBytes = 8 << 10

// Identity is what a verified token proves: who the caller is, according to
// which issuer, for which audience and session. It deliberately carries no
// roles, tenant, merchant or other custom claims: authority comes from Zoiko
// Pay's own records (merchant.memberships), never from the token (02-02 §2.2,
// 03-05 "not ... unverified JWT custom claims").
type Identity struct {
	Issuer    string
	Subject   string
	Audience  []string
	IssuedAt  time.Time
	ExpiresAt time.Time
	AuthTime  time.Time // zero when the token has no auth_time
	SessionID string    // from Config.SessionIDClaim; empty when absent
	TokenID   string    // jti; empty when absent
}

// Verifier checks access tokens from one issuer. It is safe for concurrent use.
type Verifier struct {
	cfg  Config
	algs []jose.SignatureAlgorithm
	keys *keySet
}

// NewVerifier validates cfg and returns a Verifier. It does not contact the
// issuer; keys are fetched on first use.
func NewVerifier(cfg Config) (*Verifier, error) {
	cfg, err := cfg.withDefaults()
	if err != nil {
		return nil, err
	}
	algs := make([]jose.SignatureAlgorithm, len(cfg.Algorithms))
	for i, a := range cfg.Algorithms {
		algs[i] = jose.SignatureAlgorithm(a)
	}
	return &Verifier{cfg: cfg, algs: algs, keys: newKeySet(cfg)}, nil
}

// Verify checks raw (a compact JWS access token) and returns the caller's
// identity. In order: size; an allowed asymmetric algorithm; one signature
// with a key ID and no embedded key; a known key from the JWKS whose declared
// algorithm matches; the signature; then iss, aud, sub, exp, nbf, iat, the
// maximum lifetime and the required claims. Any failure returns an error
// wrapping ErrInvalidToken or ErrKeysUnavailable.
func (v *Verifier) Verify(ctx context.Context, raw string) (Identity, error) {
	if raw == "" || len(raw) > maxTokenBytes {
		return Identity{}, invalid("token is empty or too large")
	}
	tok, err := jwt.ParseSigned(raw, v.algs)
	if err != nil {
		return Identity{}, invalid("malformed token or algorithm not allowed")
	}
	if len(tok.Headers) != 1 {
		return Identity{}, invalid("token must have exactly one signature")
	}
	h := tok.Headers[0]
	// Keys come only from the configured JWKS. A key carried in the token
	// itself proves nothing; jku, x5u and x5c are never fetched or used either.
	if h.JSONWebKey != nil {
		return Identity{}, invalid("embedded key not accepted")
	}
	if h.KeyID == "" {
		return Identity{}, invalid("token has no key ID")
	}
	key, err := v.keys.key(ctx, h.KeyID)
	if err != nil {
		return Identity{}, err
	}
	if key.Algorithm != "" && key.Algorithm != h.Algorithm {
		return Identity{}, invalid("key is not for this algorithm")
	}

	var std jwt.Claims
	var all map[string]any
	if err := tok.Claims(key.Key, &std, &all); err != nil {
		return Identity{}, invalid("signature does not verify")
	}
	return v.check(std, all)
}

func (v *Verifier) check(std jwt.Claims, all map[string]any) (Identity, error) {
	c := v.cfg
	now := c.Now()
	switch {
	case std.Issuer != c.Issuer:
		return Identity{}, invalid("unexpected issuer")
	case !slices.Contains(std.Audience, c.Audience):
		return Identity{}, invalid("token is not for this audience")
	case std.Subject == "" || len(std.Subject) > 255:
		return Identity{}, invalid("subject missing or too long")
	case std.Expiry == nil:
		return Identity{}, invalid("token has no expiry")
	case std.IssuedAt == nil:
		return Identity{}, invalid("token has no issued-at time")
	}
	exp, iat := std.Expiry.Time().UTC(), std.IssuedAt.Time().UTC() // the platform keeps times in UTC
	switch {
	case !now.Before(exp.Add(c.Leeway)):
		return Identity{}, invalid("token expired")
	case std.NotBefore != nil && now.Add(c.Leeway).Before(std.NotBefore.Time()):
		return Identity{}, invalid("token not valid yet")
	case now.Add(c.Leeway).Before(iat):
		return Identity{}, invalid("token issued in the future")
	case exp.Sub(iat) > c.MaxLifetime:
		return Identity{}, invalid("token lifetime exceeds the maximum")
	}
	for name, want := range c.RequiredClaims {
		if got, ok := all[name].(string); !ok || got != want {
			return Identity{}, invalid("required claim " + name + " missing or wrong")
		}
	}

	id := Identity{
		Issuer: std.Issuer, Subject: std.Subject, Audience: slices.Clone([]string(std.Audience)),
		IssuedAt: iat, ExpiresAt: exp, TokenID: std.ID,
	}
	if s, ok := all[c.SessionIDClaim].(string); ok {
		id.SessionID = s
	}
	if t, ok := numericClaim(all["auth_time"]); ok {
		id.AuthTime = time.Unix(t, 0).UTC()
	}
	return id, nil
}

func numericClaim(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	default:
		return 0, false
	}
}
