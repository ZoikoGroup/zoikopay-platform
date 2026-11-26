//go:build integration

package http_test

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/governance"
	merchanthttp "github.com/zoiko/zoikopay/internal/merchant/http"
	"github.com/zoiko/zoikopay/internal/merchant/store"
	"github.com/zoiko/zoikopay/internal/platform/authn"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
	"github.com/zoiko/zoikopay/internal/platform/httpserver"
	"github.com/zoiko/zoikopay/internal/platform/ids"
	"github.com/zoiko/zoikopay/internal/platform/migrate"
)

const (
	issuer   = "http://localhost:8180/realms/zoikopay"
	audience = "zoikopay-gateway"
)

// Synthetic people (Keycloak-style subject IDs).
const (
	owner   = "00000000-0000-4000-8000-0000000000a1" // MOWN, tenant A, every merchant
	ops     = "00000000-0000-4000-8000-0000000000a2" // MOPS, tenant A, merchant A1 only
	dev     = "00000000-0000-4000-8000-0000000000a3" // MDEV, tenant A (no MERCHANT.PROFILE.READ)
	viewerB = "00000000-0000-4000-8000-0000000000b1" // MVIEW, tenant B
	revokee = "00000000-0000-4000-8000-0000000000a4" // MVIEW, tenant A, revoked during the test
	nobody  = "00000000-0000-4000-8000-000000000000" // valid token, no grant
	makerID = "00000000-0000-4000-8000-0000000000f1"
	checkID = "00000000-0000-4000-8000-0000000000f2"
)

type gateway struct {
	t       *testing.T
	handler http.Handler
	key     *rsa.PrivateKey
	gw      *pgxpool.Pool
	logs    *bytes.Buffer
	audit   *governance.AuditLog // as zp_audit, like the gateway binary
	su      *pgxpool.Pool        // superuser: sees every entry, for assertions only
}

func (g *gateway) token(sub string, edit ...func(map[string]any)) string {
	g.t.Helper()
	now := time.Now()
	c := map[string]any{"iss": issuer, "aud": audience, "sub": sub, "typ": "Bearer",
		"iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix()}
	for _, f := range edit {
		f(c)
	}
	return sign(g.t, g.key, c)
}

func sign(t *testing.T, key *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	s, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
	if err != nil {
		t.Fatal(err)
	}
	tok, err := jwt.Signed(s).Claims(claims).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func (g *gateway) get(path, token string, edit ...func(*http.Request)) *httptest.ResponseRecorder {
	g.t.Helper()
	req := httptest.NewRequestWithContext(g.t.Context(), http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for _, f := range edit {
		f(req)
	}
	rec := httptest.NewRecorder()
	g.handler.ServeHTTP(rec, req)
	return rec
}

// inTenant writes fixtures as BC-01's runtime role inside a tenant transaction.
func (g *gateway) inTenant(tenant string, sql string, args ...any) {
	g.t.Helper()
	err := db.InTenantTx(g.t.Context(), g.gw, db.Tenant{Environment: "TEST", CellID: "cell_fixture", LegalEntityID: "le_fixture", TenantID: tenant},
		func(tx pgx.Tx) error { _, err := tx.Exec(g.t.Context(), sql, args...); return err })
	if err != nil {
		g.t.Fatalf("fixture: %v", err)
	}
}

func (g *gateway) tenant(name string) string {
	id := ids.NewPublic(ids.Tenant)
	g.inTenant(id, `INSERT INTO merchant.tenants VALUES ($1::uuid, $2, $3, now(), now())`, ids.NewInternal(), id, name)
	return id
}

func (g *gateway) merchant(tenant, env, name string) string {
	id := ids.NewPublic(ids.Merchant)
	g.inTenant(tenant, `INSERT INTO merchant.merchants (id, merchant_id, tenant_id, environment, display_name, status, revision, created_at_utc, updated_at_utc)
		VALUES ($1::uuid, $2, $3, $4, $5, 'DRAFT', 1, '2026-11-07T00:00:00Z', '2026-11-07T00:00:00Z')`, ids.NewInternal(), id, tenant, env, name)
	return id
}

func (g *gateway) grant(sub, tenant, merchant, persona string) string {
	id := ids.NewInternal()
	var m any
	if merchant != "" {
		m = merchant
	}
	at := time.Now().UTC().Add(-time.Hour)
	g.inTenant(tenant, `INSERT INTO merchant.memberships (id, issuer, subject, tenant_id, merchant_id, environment, persona,
		granted_by_issuer, granted_by_subject, approved_by_issuer, approved_by_subject, granted_at_utc, effective_from_utc, expires_at_utc)
		VALUES ($1::uuid, $2, $3, $4, $5, 'TEST', $6, $2, $7, $2, $8, $9, $9, $10)`,
		id, issuer, sub, tenant, m, persona, makerID, checkID, at, at.Add(48*time.Hour))
	return id
}

func setup(t *testing.T) *gateway {
	t.Helper()
	pg := dbtest.Start(t)
	r := migrate.Runner{Pool: pg.Pool(t, "zp_migrator"), Source: os.DirFS(filepath.Join(dbtest.RepoRoot(t), "db", "migrations"))}
	if _, err := r.Up(t.Context()); err != nil {
		t.Fatalf("apply real migrations: %v", err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: key.Public(), KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	}))
	t.Cleanup(jwks.Close)
	verifier, err := authn.NewVerifier(authn.Config{Issuer: issuer, Audience: audience, JWKSURL: jwks.URL,
		RequiredClaims: map[string]string{"typ": "Bearer"}})
	if err != nil {
		t.Fatal(err)
	}
	gw := pg.Pool(t, "zp_gateway")
	resolver, err := authz.NewResolver(store.NewGrantSource(gw), "TEST", nil)
	if err != nil {
		t.Fatal(err)
	}
	logs := &bytes.Buffer{}
	log := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	srv := httpserver.New(httpserver.Config{Name: "gateway"}, log)
	auditStore := governance.NewAuditLog(pg.Pool(t, "zp_audit"))
	merchanthttp.Mount(srv.Mux(), merchanthttp.Deps{Pool: gw, Verifier: verifier, Resolver: resolver, Log: log,
		Audit: auditStore, Environment: "TEST"})
	return &gateway{t: t, handler: srv.Handler(), key: key, gw: gw, logs: logs, audit: auditStore, su: pg.Pool(t, "postgres")}
}

type problem struct {
	Type, Title, Code, Detail string
	Status                    int
	RequestID                 string `json:"request_id"`
	TraceID                   string `json:"trace_id"`
	Retryable                 bool
}

var traceFormat = regexp.MustCompile(`^[0-9a-f]{32}$`)

func wantTrace(t *testing.T, what string, rec *httptest.ResponseRecorder) string {
	t.Helper()
	id := rec.Header().Get("X-Trace-Id")
	if !traceFormat.MatchString(id) {
		t.Errorf("%s: X-Trace-Id = %q", what, id)
	}
	return id
}

func wantProblem(t *testing.T, what string, rec *httptest.ResponseRecorder, status int, code string) problem {
	t.Helper()
	id := wantTrace(t, what, rec)
	var p problem
	if rec.Code != status {
		t.Errorf("%s: status %d; want %d (body %s)", what, rec.Code, status, rec.Body)
		return p
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil || rec.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("%s: not an RFC 9457 problem (%v): %s", what, err, rec.Body)
	}
	if p.Code != code || p.TraceID != id || p.RequestID != id {
		t.Errorf("%s: problem %+v; want code %s and trace_id = request_id = X-Trace-Id %s", what, p, code, id)
	}
	p.TraceID, p.RequestID = "", ""
	return p
}

type merchantBody struct {
	ID          string `json:"id"`
	Object      string `json:"object"`
	DisplayName string `json:"display_name"`
	Status      string `json:"status"`
	Revision    int64  `json:"revision"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

func wantMerchant(t *testing.T, what string, rec *httptest.ResponseRecorder, id, name string) {
	t.Helper()
	wantTrace(t, what, rec)
	if rec.Code != http.StatusOK {
		t.Errorf("%s: status %d; want 200 (body %s)", what, rec.Code, rec.Body)
		return
	}
	var m merchantBody
	dec := json.NewDecoder(rec.Body)
	dec.DisallowUnknownFields() // the contract has additionalProperties: false
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("%s: body does not match the Merchant schema: %v", what, err)
	}
	want := merchantBody{ID: id, Object: "merchant", DisplayName: name, Status: "draft", Revision: 1,
		CreatedAt: "2026-11-07T00:00:00Z", UpdatedAt: "2026-11-07T00:00:00Z"}
	if m != want {
		t.Errorf("%s: merchant %+v; want %+v", what, m, want)
	}
	if etag := rec.Header().Get("ETag"); etag != `"merchant-rev-1"` {
		t.Errorf("%s: ETag %q; want \"merchant-rev-1\"", what, etag)
	}
}

// TestGetMerchant drives GET /v1/merchants/{merchant_id} through the real
// gateway stack: trace middleware, token verification (ADR 0007), principal
// resolution from merchant.memberships (Q36) and a tenant transaction with
// row-level security. Response codes follow OPEN_QUESTIONS Q37.
func TestGetMerchant(t *testing.T) {
	g := setup(t)
	tenantA, tenantB := g.tenant("Synthetic Tenant A"), g.tenant("Synthetic Tenant B")
	merA1 := g.merchant(tenantA, "TEST", "A One")
	merA2 := g.merchant(tenantA, "TEST", "A Two")
	merALive := g.merchant(tenantA, "LIVE", "A Live")
	merB1 := g.merchant(tenantB, "TEST", "B One")
	g.grant(owner, tenantA, "", "MOWN")
	g.grant(ops, tenantA, merA1, "MOPS")
	g.grant(dev, tenantA, "", "MDEV")
	g.grant(viewerB, tenantB, "", "MVIEW")
	revokeeGrant := g.grant(revokee, tenantA, "", "MVIEW")
	path := func(id string) string { return "/v1/merchants/" + id }
	unknown := ids.NewPublic(ids.Merchant)

	t.Run("a member with the permission reads the merchant", func(t *testing.T) {
		wantMerchant(t, "owner, merchant A1", g.get(path(merA1), g.token(owner)), merA1, "A One")
		wantMerchant(t, "owner, merchant A2", g.get(path(merA2), g.token(owner)), merA2, "A Two")
		wantMerchant(t, "viewer B, merchant B1", g.get(path(merB1), g.token(viewerB)), merB1, "B One")
	})

	t.Run("rule 1: missing, malformed, expired, wrong-audience or forged token is 401", func(t *testing.T) {
		attacker, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		var bodies []problem
		for name, rec := range map[string]*httptest.ResponseRecorder{
			"no token":        g.get(path(merA1), ""),
			"malformed token": g.get(path(merA1), "not.a.token"),
			"expired": g.get(path(merA1), g.token(owner, func(c map[string]any) {
				c["exp"], c["iat"] = time.Now().Add(-time.Hour).Unix(), time.Now().Add(-2*time.Hour).Unix()
			})),
			"wrong audience": g.get(path(merA1), g.token(owner, func(c map[string]any) { c["aud"] = "another-api" })),
			"forged: signed by an attacker's key": g.get(path(merA1), sign(t, attacker, map[string]any{
				"iss": issuer, "aud": audience, "sub": owner, "typ": "Bearer",
				"iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix()})),
		} {
			bodies = append(bodies, wantProblem(t, name, rec, http.StatusUnauthorized, "authentication_required"))
		}
		for _, b := range bodies[1:] {
			if b != bodies[0] {
				t.Errorf("401 bodies differ: %+v vs %+v", bodies[0], b)
			}
		}
	})

	t.Run("rule 2: valid token without a live grant is denied", func(t *testing.T) {
		wantProblem(t, "no grant, existing merchant", g.get(path(merA1), g.token(nobody)), http.StatusNotFound, "resource_not_found")
	})

	t.Run("rule 3: another tenant's merchant is 404, identical to one that does not exist", func(t *testing.T) {
		other := wantProblem(t, "viewer B reads merchant A1", g.get(path(merA1), g.token(viewerB)), http.StatusNotFound, "resource_not_found")
		missing := wantProblem(t, "viewer B reads an unknown merchant", g.get(path(unknown), g.token(viewerB)), http.StatusNotFound, "resource_not_found")
		reverse := wantProblem(t, "owner A reads merchant B1", g.get(path(merB1), g.token(owner)), http.StatusNotFound, "resource_not_found")
		if other != missing || reverse != missing {
			t.Errorf("404 bodies differ, which reveals that the merchant exists:\n%+v\n%+v\n%+v", other, missing, reverse)
		}
		wantProblem(t, "sibling merchant without a relation (AT-007)", g.get(path(merA2), g.token(ops)), http.StatusNotFound, "resource_not_found")
		wantProblem(t, "merchant in another environment", g.get(path(merALive), g.token(owner)), http.StatusNotFound, "resource_not_found")
		wantProblem(t, "malformed merchant id", g.get(path("not-a-merchant-id"), g.token(owner)), http.StatusNotFound, "resource_not_found")
	})

	t.Run("rule 4: own tenant without the permission is 403", func(t *testing.T) {
		wantProblem(t, "MDEV reads a merchant of its tenant", g.get(path(merA1), g.token(dev)), http.StatusForbidden, "permission_denied")
		wantMerchant(t, "MOPS reads its own merchant", g.get(path(merA1), g.token(ops)), merA1, "A One")
	})

	t.Run("rule 5: forged claims, headers, query and body grant nothing", func(t *testing.T) {
		forgedToken := g.token(viewerB, func(c map[string]any) {
			c["tenant_id"], c["merchant_id"], c["roles"] = tenantA, merA1, []string{"MOWN", "SUPER_ADMIN"}
			c["user_metadata"] = map[string]any{"tenant_id": tenantA, "persona": "MOWN"}
			c["app_metadata"] = map[string]any{"tenant_id": tenantA}
		})
		forge := func(r *http.Request) {
			for h, v := range map[string]string{"X-Tenant-Id": tenantA, "X-Merchant-Id": merA1, "X-Role": "MOWN",
				"X-User-Id": owner, "X-Subject": owner, "X-Forwarded-User": "super.admin", "X-Environment": "TEST"} {
				r.Header.Set(h, v)
			}
			r.URL.RawQuery = "tenant_id=" + tenantA + "&role=MOWN&sub=" + owner
			r.Body = http.NoBody
		}
		wantProblem(t, "viewer B with forged claims and headers reads merchant A1",
			g.get(path(merA1), forgedToken, forge), http.StatusNotFound, "resource_not_found")
		wantProblem(t, "no-grant caller with forged headers naming the owner",
			g.get(path(merA1), g.token(nobody), forge), http.StatusNotFound, "resource_not_found")
		wantProblem(t, "MDEV with a forged MOWN role header",
			g.get(path(merA1), g.token(dev), forge), http.StatusForbidden, "permission_denied")
	})

	t.Run("a revoked grant denies on the next request while the token is valid", func(t *testing.T) {
		tok := g.token(revokee)
		wantMerchant(t, "before revocation", g.get(path(merA1), tok), merA1, "A One")
		g.inTenant(tenantA, `UPDATE merchant.memberships SET revoked_at_utc = now(), revoked_by_issuer = $2, revoked_by_subject = $3 WHERE id = $1::uuid`,
			revokeeGrant, issuer, checkID)
		wantProblem(t, "after revocation", g.get(path(merA1), tok), http.StatusNotFound, "resource_not_found")
	})

	t.Run("unknown /v1 routes: 401 before authentication, 404 problem after", func(t *testing.T) {
		wantProblem(t, "no token", g.get("/v1/no_such_route", ""), http.StatusUnauthorized, "authentication_required")
		wantProblem(t, "with token", g.get("/v1/no_such_route", g.token(owner)), http.StatusNotFound, "resource_not_found")
	})

	t.Run("rule 8: no token reaches the log", func(t *testing.T) {
		logs := g.logs.String()
		for _, sub := range []string{owner, ops, dev, viewerB, nobody} {
			tok := g.token(sub)
			if strings.Contains(logs, strings.Split(tok, ".")[0]+".") || strings.Contains(logs, "Bearer") || strings.Contains(logs, "Authorization") {
				t.Fatalf("the log contains token material or the Authorization header")
			}
		}
		if !strings.Contains(logs, `"path":"/v1/merchants/`) {
			t.Error("the access log is missing")
		}
	})
}
