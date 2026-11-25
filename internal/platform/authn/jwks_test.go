package authn

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

// The JWKS filter keeps only public signing keys with a unique key ID. Tested
// directly, because the library would refuse most of the dropped keys later
// anyway; this pins the filter itself.
func TestFetchKeepsOnlyPublicSigningKeys(t *testing.T) {
	r1, _ := rsa.GenerateKey(rand.Reader, 2048)
	r2, _ := rsa.GenerateKey(rand.Reader, 2048)
	ec, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	set := jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
		{Key: r1.Public(), KeyID: "good-rsa", Algorithm: "RS256", Use: "sig"},
		{Key: ec.Public(), KeyID: "good-ec", Algorithm: "ES256"}, // "use" is optional
		{Key: r2, KeyID: "private", Algorithm: "RS256"},
		{Key: []byte("shared-secret-of-32-bytes-long!!"), KeyID: "symmetric", Algorithm: "HS256"},
		{Key: r2.Public(), KeyID: "encryption", Use: "enc"},
		{Key: r2.Public(), KeyID: "twice", Algorithm: "RS256"},
		{Key: ec.Public(), KeyID: "twice", Algorithm: "ES256"},
		{Key: r2.Public(), Algorithm: "RS256"}, // no key ID
	}}
	body, err := json.Marshal(set)
	if err != nil {
		t.Fatal(err)
	}
	// An entry this library cannot parse must be skipped, not fail the set.
	var doc map[string][]json.RawMessage
	_ = json.Unmarshal(body, &doc)
	doc["keys"] = append(doc["keys"], json.RawMessage(`{"kty":"unknown-type","kid":"odd"}`))
	body, _ = json.Marshal(doc)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) }))
	defer srv.Close()
	cfg, err := Config{Issuer: "https://idp.example.test", Audience: "a", JWKSURL: srv.URL, Now: time.Now}.withDefaults()
	if err != nil {
		t.Fatal(err)
	}
	keys, err := newKeySet(cfg).fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := slices.Sorted(maps.Keys(keys)); !slices.Equal(got, []string{"good-ec", "good-rsa"}) {
		t.Errorf("kept key IDs %v; want only [good-ec good-rsa]", got)
	}
}
