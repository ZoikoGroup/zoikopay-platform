package authn

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

const maxJWKSBytes = 1 << 20

// keySet caches the issuer's public signing keys by key ID.
//
//   - Keys are refreshed after KeyCacheTTL, or early when a token names an
//     unknown key ID (the issuer rotated keys), but never more often than
//     KeyRefreshInterval, so made-up key IDs cannot flood the issuer.
//   - If a refresh fails, the last good keys stay in use for up to KeyMaxStale;
//     after that verification fails closed with ErrKeysUnavailable.
//   - Only public, valid signing keys with a key ID are kept. Private and
//     symmetric keys are ignored, and a key ID listed twice is dropped as
//     ambiguous.
type keySet struct {
	cfg Config

	mu          sync.Mutex
	keys        map[string]jose.JSONWebKey
	fetchedAt   time.Time // last successful fetch
	attemptedAt time.Time // last fetch attempt, successful or not
	fetches     int       // attempts made (observability and tests)
}

func newKeySet(cfg Config) *keySet { return &keySet{cfg: cfg} }

// key returns the signing key for kid. The lock is held across a fetch so
// that concurrent callers wait for one fetch instead of starting their own.
func (s *keySet) key(ctx context.Context, kid string) (jose.JSONWebKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.cfg.Now()

	k, known := s.keys[kid]
	expired := s.fetchedAt.IsZero() || now.Sub(s.fetchedAt) >= s.cfg.KeyCacheTTL
	mayFetch := s.attemptedAt.IsZero() || now.Sub(s.attemptedAt) >= s.cfg.KeyRefreshInterval
	var fetchErr error
	if (expired || !known) && mayFetch {
		s.attemptedAt = now
		s.fetches++
		if keys, err := s.fetch(ctx); err != nil {
			fetchErr = err
		} else {
			s.keys, s.fetchedAt = keys, now
		}
		k, known = s.keys[kid]
	}

	if s.keys == nil || now.Sub(s.fetchedAt) > s.cfg.KeyMaxStale {
		if fetchErr == nil && s.keys == nil {
			fetchErr = fmt.Errorf("no keys fetched yet; next attempt after %s", s.cfg.KeyRefreshInterval)
		} else if fetchErr == nil {
			fetchErr = fmt.Errorf("keys older than %s and no refresh allowed yet", s.cfg.KeyMaxStale)
		}
		return jose.JSONWebKey{}, fmt.Errorf("%w: %w", ErrKeysUnavailable, fetchErr)
	}
	if !known {
		return jose.JSONWebKey{}, invalid("unknown key ID")
	}
	return k, nil
}

func (s *keySet) fetch(ctx context.Context) (map[string]jose.JSONWebKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.JWKSURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/jwk-set+json, application/json")
	resp, err := s.cfg.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch JWKS: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch JWKS: status %d", resp.StatusCode)
	}
	var doc struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxJWKSBytes)).Decode(&doc); err != nil {
		return nil, fmt.Errorf("decode JWKS: %w", err)
	}

	keys := map[string]jose.JSONWebKey{}
	duplicate := map[string]bool{}
	for _, raw := range doc.Keys {
		var k jose.JSONWebKey
		// Skip, rather than fail on, a key this library cannot read (for
		// example an encryption-only key type), so one odd key cannot stop
		// verification with the others.
		if err := k.UnmarshalJSON(raw); err != nil {
			continue
		}
		if k.KeyID == "" || !k.IsPublic() || !k.Valid() || (k.Use != "" && k.Use != "sig") {
			continue
		}
		if _, seen := keys[k.KeyID]; seen || duplicate[k.KeyID] {
			delete(keys, k.KeyID)
			duplicate[k.KeyID] = true
			continue
		}
		keys[k.KeyID] = k
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("JWKS has no usable signing keys")
	}
	return keys, nil
}
