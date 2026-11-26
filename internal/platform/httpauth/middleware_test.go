package httpauth_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"github.com/zoiko/zoikopay/internal/platform/authn"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/httpauth"
	"github.com/zoiko/zoikopay/internal/platform/trace"
)

const (
	issuer   = "http://localhost:8180/realms/zoikopay"
	audience = "zoikopay-gateway"
	alice    = "00000000-0000-4000-8000-00000000a11c"
	tenantA  = "ten_a"
	tenantB  = "ten_b"
)

// grants is a fake BC-01 grant store behind the real resolver.
type grants struct {
	mu     sync.Mutex
	byWho  map[db.Subject][]authz.Grant
	err    error
	calls  atomic.Int32
	askedM sync.Map // db.Subject → true
}

func (g *grants) GrantsForSubject(_ context.Context, s db.Subject) ([]authz.Grant, error) {
	g.calls.Add(1)
	g.askedM.Store(s, true)
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.byWho[s]), g.err
}

func grant(sub, tenant, env string, p authz.Persona) authz.Grant {
	now := time.Now()
	return authz.Grant{ID: "g-" + tenant + "-" + string(p), Subject: db.Subject{Issuer: issuer, Subject: sub},
		TenantID: tenant, Environment: env, Persona: p, EffectiveFrom: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour)}
}

// env is a gateway in front of a handler that records what it was given.
type env struct {
	t       *testing.T
	key     *rsa.PrivateKey
	jwksOK  atomic.Bool
	grants  *grants
	logs    *bytes.Buffer
	handler http.Handler
	reached atomic.Int32
	seen    authz.Principal
	seenID  string
	v       *authn.Verifier
	r       *authz.Resolver
}

// parts returns the real verifier and resolver behind the gateway.
func (e *env) parts() (*authn.Verifier, *authz.Resolver) { return e.v, e.r }

func newEnv(t *testing.T) *env {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, key: key, grants: &grants{byWho: map[db.Subject][]authz.Grant{}}, logs: &bytes.Buffer{}}
	e.jwksOK.Store(true)
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if !e.jwksOK.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: key.Public(), KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	}))
	t.Cleanup(jwks.Close)
	v, err := authn.NewVerifier(authn.Config{Issuer: issuer, Audience: audience, JWKSURL: jwks.URL,
		RequiredClaims: map[string]string{"typ": "Bearer"}})
	if err != nil {
		t.Fatal(err)
	}
	r, err := authz.NewResolver(e.grants, "TEST", nil)
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewJSONHandler(e.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.reached.Add(1)
		e.seen, _ = httpauth.PrincipalFrom(r.Context())
		e.seenID = trace.ID(r.Context())
		w.WriteHeader(http.StatusNoContent)
	})
	e.v, e.r = v, r
	e.handler = trace.Middleware(log, httpauth.Authenticate(v, r, log)(inner))
	return e
}

func (e *env) claims() map[string]any {
	now := time.Now()
	return map[string]any{"iss": issuer, "aud": audience, "sub": alice, "typ": "Bearer",
		"iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix()}
}

func (e *env) sign(claims map[string]any) string { return signWith(e.t, e.key, "k1", claims) }

func signWith(t *testing.T, key *rsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	s, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithHeader("kid", kid))
	if err != nil {
		t.Fatal(err)
	}
	tok, err := jwt.Signed(s).Claims(claims).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func (e *env) do(token string, edit ...func(*http.Request)) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequestWithContext(e.t.Context(), http.MethodGet, "/v1/merchants/mer_x", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for _, f := range edit {
		f(req)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec
}

type problem struct {
	Type, Title, Code, Detail string
	Status                    int
	RequestID                 string `json:"request_id"`
	TraceID                   string `json:"trace_id"`
	Retryable                 bool
}

var traceFormat = regexp.MustCompile(`^[0-9a-f]{32}$`)

// wantProblem checks status, code, RFC 9457 shape and trace ID agreement (Q37 37.1–37.2).
func wantProblem(t *testing.T, what string, rec *httptest.ResponseRecorder, status int, code string) problem {
	t.Helper()
	var p problem
	if rec.Code != status {
		t.Errorf("%s: status %d; want %d (body %s)", what, rec.Code, status, rec.Body)
		return p
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Errorf("%s: Content-Type %q; want application/problem+json", what, ct)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("%s: body is not JSON: %v", what, err)
	}
	id := rec.Header().Get("X-Trace-Id")
	if p.Code != code || p.Status != status || !traceFormat.MatchString(id) || p.TraceID != id || p.RequestID != id {
		t.Errorf("%s: problem %+v, X-Trace-Id %q; want code %s, status %d and trace_id = request_id = header", what, p, id, code, status)
	}
	return p
}

// Q37 37.3: every authentication failure is the same 401.
func TestMissingOrMalformedCredentialsAre401(t *testing.T) {
	e := newEnv(t)
	valid := e.sign(e.claims())
	var bodies []problem
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"no Authorization header":   e.do(""),
		"Basic credentials":         e.do("", func(r *http.Request) { r.Header.Set("Authorization", "Basic YWxpY2U6cHc=") }),
		"empty bearer":              e.do("", func(r *http.Request) { r.Header.Set("Authorization", "Bearer ") }),
		"two Authorization headers": e.do(valid, func(r *http.Request) { r.Header.Add("Authorization", "Bearer "+valid) }),
		"token in the query only":   e.do("", func(r *http.Request) { r.URL.RawQuery = "access_token=" + valid }),
		"token in a cookie only": e.do("", func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: "access_token", Value: valid, Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode})
		}),
	} {
		p := wantProblem(t, name, rec, http.StatusUnauthorized, "authentication_required")
		if !strings.HasPrefix(rec.Header().Get("WWW-Authenticate"), "Bearer") {
			t.Errorf("%s: WWW-Authenticate = %q; want a Bearer challenge", name, rec.Header().Get("WWW-Authenticate"))
		}
		bodies = append(bodies, p)
	}
	assertSameBody(t, bodies)
	if e.reached.Load() != 0 || e.grants.calls.Load() != 0 {
		t.Errorf("handler reached %d times, grants read %d times; want 0 and 0", e.reached.Load(), e.grants.calls.Load())
	}
}

// Q37 37.3: tokens that fail verification are 401 with the same body,
// including forged ones; no grant is read for them.
func TestInvalidAndForgedTokensAre401(t *testing.T) {
	e := newEnv(t)
	attacker, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	mod := func(f func(map[string]any)) string { c := e.claims(); f(c); return e.sign(c) }
	valid := e.sign(e.claims())
	parts := strings.Split(valid, ".")
	forgedPayload, _ := json.Marshal(map[string]any{"iss": issuer, "aud": audience, "sub": "00000000-0000-4000-8000-000000000001",
		"typ": "Bearer", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix()})
	b64 := base64.RawURLEncoding.EncodeToString

	var bodies []problem
	for name, tok := range map[string]string{
		"expired": mod(func(c map[string]any) {
			c["exp"] = time.Now().Add(-time.Hour).Unix()
			c["iat"] = time.Now().Add(-2 * time.Hour).Unix()
		}),
		"wrong audience":                          mod(func(c map[string]any) { c["aud"] = "another-api" }),
		"wrong issuer":                            mod(func(c map[string]any) { c["iss"] = "https://evil.example.test/realms/zoikopay" }),
		"ID token, not an access token":           mod(func(c map[string]any) { c["typ"] = "ID" }),
		"forged: signed by an attacker's key":     signWith(t, attacker, "k1", e.claims()),
		"forged: payload swapped for super.admin": parts[0] + "." + b64(forgedPayload) + "." + parts[2],
		"forged: alg none":                        b64([]byte(`{"alg":"none","kid":"k1"}`)) + "." + parts[1] + ".",
		"not a JWT":                               "not-a-token",
	} {
		bodies = append(bodies, wantProblem(t, name, e.do(tok), http.StatusUnauthorized, "authentication_required"))
	}
	assertSameBody(t, bodies)
	if e.reached.Load() != 0 || e.grants.calls.Load() != 0 {
		t.Errorf("handler reached %d times, grants read %d times; want 0 and 0", e.reached.Load(), e.grants.calls.Load())
	}
}

// Rule 5: tenant and role come only from memberships. A valid token full of
// forged authority, sent with forged headers, query and body, resolves to
// exactly the caller's grants, read for the token's own subject.
func TestForgedClaimsHeadersQueryAndBodyAreIgnored(t *testing.T) {
	e := newEnv(t)
	e.grants.byWho[db.Subject{Issuer: issuer, Subject: alice}] = []authz.Grant{grant(alice, tenantA, "TEST", authz.MVIEW)}
	c := e.claims()
	c["tenant_id"], c["merchant_id"], c["roles"] = tenantB, "mer_b", []string{"SUPER_ADMIN", "MOWN"}
	c["user_metadata"] = map[string]any{"tenant_id": tenantB, "persona": "MOWN"}
	c["app_metadata"] = map[string]any{"tenant_id": tenantB}
	rec := e.do(e.sign(c), func(r *http.Request) {
		for h, v := range map[string]string{
			"X-Tenant-Id": tenantB, "X-Merchant-Id": "mer_b", "X-Role": "MOWN", "X-Persona": "SUPER_ADMIN",
			"X-User-Id": "00000000-0000-4000-8000-000000000001", "X-Subject": "00000000-0000-4000-8000-000000000001",
			"X-Forwarded-User": "super.admin", "X-Environment": "LIVE",
		} {
			r.Header.Set(h, v)
		}
		r.URL.RawQuery = "tenant_id=" + tenantB + "&role=MOWN&sub=00000000-0000-4000-8000-000000000001"
		r.Body = http.NoBody
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d; want the handler's 204 (body %s)", rec.Code, rec.Body)
	}
	p := e.seen
	if p.Identity.Subject != alice || p.Environment != "TEST" {
		t.Errorf("principal subject %q env %q; want the token's subject and the deployment's TEST", p.Identity.Subject, p.Environment)
	}
	if !slices.Equal(p.Tenants(), []string{tenantA}) || p.Holds(authz.MOWN, tenantB, "mer_b") || p.Holds(authz.MOWN, tenantA, "") {
		t.Errorf("principal tenants %v: forged authority leaked in", p.Tenants())
	}
	n := 0
	e.grants.askedM.Range(func(k, _ any) bool {
		n++
		if k.(db.Subject) != (db.Subject{Issuer: issuer, Subject: alice}) {
			t.Errorf("grants read for %+v; want only the token's subject", k)
		}
		return true
	})
	if n != 1 {
		t.Errorf("grants read for %d subjects; want 1", n)
	}
}

func TestValidRequestReachesHandlerWithPrincipalAndTraceID(t *testing.T) {
	e := newEnv(t)
	e.grants.byWho[db.Subject{Issuer: issuer, Subject: alice}] = []authz.Grant{grant(alice, tenantA, "TEST", authz.MOWN)}
	rec := e.do(e.sign(e.claims()))
	if rec.Code != http.StatusNoContent || e.reached.Load() != 1 {
		t.Fatalf("status %d, handler reached %d times; want 204 and 1", rec.Code, e.reached.Load())
	}
	if !e.seen.Holds(authz.MOWN, tenantA, "mer_x") {
		t.Error("the handler did not receive the resolved principal")
	}
	if id := rec.Header().Get("X-Trace-Id"); id == "" || e.seenID != id {
		t.Errorf("trace ID in handler %q, header %q; want the same", e.seenID, id)
	}
}

// Valid token, no live grant: the request proceeds with a principal that can
// do nothing, so every route denies (Q37 37.7).
func TestNoGrantGivesAPrincipalWithNoAccess(t *testing.T) {
	e := newEnv(t)
	if rec := e.do(e.sign(e.claims())); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d", rec.Code)
	}
	if e.seen.HasAccess() || len(e.seen.Tenants()) != 0 {
		t.Errorf("principal without grants has access: %v", e.seen.Tenants())
	}
}

// Q37 37.4: outages fail closed with 503, never a permissive fallback.
func TestDependencyOutagesAre503(t *testing.T) {
	e := newEnv(t)
	e.jwksOK.Store(false)
	wantProblem(t, "signing keys unavailable", e.do(e.sign(e.claims())), http.StatusServiceUnavailable, "temporarily_unavailable")

	e2 := newEnv(t)
	e2.grants.err = errors.New("database unreachable")
	wantProblem(t, "grants unreadable", e2.do(e2.sign(e2.claims())), http.StatusServiceUnavailable, "temporarily_unavailable")
	if e.reached.Load()+e2.reached.Load() != 0 {
		t.Error("a request reached the handler during an outage")
	}
}

// Q37 37.8: grants in both environments (02-02 §2.4) are refused.
func TestAmbiguousPrincipalIs403(t *testing.T) {
	e := newEnv(t)
	e.grants.byWho[db.Subject{Issuer: issuer, Subject: alice}] = []authz.Grant{
		grant(alice, tenantA, "TEST", authz.MOWN), grant(alice, tenantB, "LIVE", authz.MVIEW)}
	wantProblem(t, "grants in TEST and LIVE", e.do(e.sign(e.claims())), http.StatusForbidden, "permission_denied")
	if e.reached.Load() != 0 {
		t.Error("an ambiguous principal reached the handler")
	}
}

// Rule 8, Q37 37.13: no token, signature or header value reaches the log on
// any path, while the trace ID does.
func TestTokensNeverReachTheLog(t *testing.T) {
	e := newEnv(t)
	e.grants.byWho[db.Subject{Issuer: issuer, Subject: alice}] = []authz.Grant{grant(alice, tenantA, "TEST", authz.MOWN)}
	valid := e.sign(e.claims())
	expired := func() string {
		c := e.claims()
		c["exp"], c["iat"] = time.Now().Add(-time.Hour).Unix(), time.Now().Add(-2*time.Hour).Unix()
		return e.sign(c)
	}()
	var ids []string
	for _, tok := range []string{valid, expired, valid + "x", "not-a-token"} {
		ids = append(ids, e.do(tok).Header().Get("X-Trace-Id"))
	}
	e.jwksOK.Store(false)
	other := newEnv(t) // fresh verifier, so the outage path really runs
	other.jwksOK.Store(false)
	ids = append(ids, other.do(other.sign(other.claims())).Header().Get("X-Trace-Id"))

	logs := e.logs.String() + other.logs.String()
	for _, tok := range []string{valid, expired, other.sign(other.claims())} {
		for i, part := range strings.Split(tok, ".") {
			if len(part) > 8 && strings.Contains(logs, part) {
				t.Errorf("token part %d found in the log", i)
			}
		}
	}
	for _, s := range []string{"Bearer", "Authorization", "not-a-token"} {
		if strings.Contains(logs, s) {
			t.Errorf("log contains %q", s)
		}
	}
	for _, id := range ids {
		if !strings.Contains(logs, id) {
			t.Errorf("trace ID %s missing from the log", id)
		}
	}
}

func assertSameBody(t *testing.T, ps []problem) {
	t.Helper()
	for i := range ps {
		ps[i].TraceID, ps[i].RequestID = "", ""
		if ps[i] != ps[0] {
			t.Errorf("401 bodies differ, which reveals why a token failed:\n%+v\n%+v", ps[0], ps[i])
		}
	}
}
