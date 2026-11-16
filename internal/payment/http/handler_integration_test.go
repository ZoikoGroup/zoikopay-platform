//go:build integration

package http_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	stdhttp "net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zoiko/zoikopay/internal/payment/app"
	paymenthttp "github.com/zoiko/zoikopay/internal/payment/http"
	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
	"github.com/zoiko/zoikopay/internal/platform/migrate"
)

type allow struct{}

func (allow) Decide(context.Context, app.Scope, app.Action, app.PolicyRequest) (app.PolicyDecision, error) {
	return app.PolicyDecision{Allowed: true, PolicyVersion: "policy_test_1"}, nil
}

type vault struct{}

func (vault) Verify(context.Context, app.Scope, string) error { return nil }

// headerAuth is a test authenticator: a fixed scope per X-Test-Merchant
// header. Production authentication is the D1→D2 service identity (M4).
type headerAuth struct{}

func (headerAuth) Authenticate(r *stdhttp.Request) (app.Scope, error) {
	m := r.Header.Get("X-Test-Merchant")
	if m == "" {
		return app.Scope{}, errors.New("unauthenticated")
	}
	return app.Scope{Environment: "TEST", CellID: "cell_uk_01", LegalEntityID: "le_uk", TenantID: "ten_" + m,
		MerchantID: "mer_" + m, ClientID: "app_1", PrincipalID: "sub_1"}, nil
}

func server(t *testing.T, auth paymenthttp.Authenticator) *httptest.Server {
	t.Helper()
	pg := dbtest.Start(t)
	r := migrate.Runner{Pool: pg.Pool(t, "zp_migrator"), Source: os.DirFS(filepath.Join(dbtest.RepoRoot(t), "db", "migrations"))}
	if _, err := r.Up(context.Background()); err != nil {
		t.Fatal(err)
	}
	h := &paymenthttp.Handler{Svc: &app.Service{Pool: pg.Pool(t, "zp_execution"), Eligibility: allow{}, Vault: vault{}}, Auth: auth}
	s := httptest.NewServer(h.Routes())
	t.Cleanup(s.Close)
	return s
}

type resp struct {
	status int
	header stdhttp.Header
	body   map[string]any
	raw    string
}

func call(t *testing.T, s *httptest.Server, method, path, merchant, key, body string) resp {
	t.Helper()
	req, err := stdhttp.NewRequestWithContext(context.Background(), method, s.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if merchant != "" {
		req.Header.Set("X-Test-Merchant", merchant)
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := stdhttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := resp{status: res.StatusCode, header: res.Header, raw: string(raw)}
	_ = json.Unmarshal(raw, &out.body)
	return out
}

const createBody = `{"amount_minor":"1999","currency":"GBP","capture_method":"automatic","payment_method_token":"tok_visa_1"}`

func TestHTTPContract(t *testing.T) {
	s := server(t, headerAuth{})
	k1 := `"11111111-1111-4111-8111-111111111111"`

	t.Run("authentication is required", func(t *testing.T) {
		r := call(t, s, "POST", "/v1/payment_intents", "", k1, createBody)
		if r.status != 401 || r.header.Get("Content-Type") != "application/problem+json" || r.body["code"] != "authentication_required" {
			t.Fatalf("%d %s", r.status, r.raw)
		}
	})
	t.Run("idempotency key is required on every POST", func(t *testing.T) {
		r := call(t, s, "POST", "/v1/payment_intents", "a", "", createBody)
		if r.status != 400 || r.body["code"] != "idempotency_key_required" {
			t.Fatalf("%d %s", r.status, r.raw)
		}
	})
	t.Run("strict bodies", func(t *testing.T) {
		for name, b := range map[string]string{
			"unknown field":  `{"amount_minor":"1999","currency":"GBP","capture_method":"automatic","payment_method_token":"tok_1","merchant_id":"mer_evil"}`,
			"numeric amount": `{"amount_minor":1999,"currency":"GBP","capture_method":"automatic","payment_method_token":"tok_1"}`,
			"decimal amount": `{"amount_minor":"19.99","currency":"GBP","capture_method":"automatic","payment_method_token":"tok_1"}`,
			"trailing data":  createBody + `{}`,
			"card number":    `{"amount_minor":"1","currency":"GBP","capture_method":"automatic","payment_method_token":"tok_1","pan":"4111111111111111"}`,
		} {
			r := call(t, s, "POST", "/v1/payment_intents", "a", `"`+strings.Repeat("2", 8)+`-2222-4222-8222-`+strings.Repeat("2", 12)+`"`, b)
			if r.status != 422 || r.body["code"] != "validation_error" {
				t.Errorf("%s: %d %s", name, r.status, r.raw)
			}
		}
	})

	var pi string
	t.Run("create, replay and mismatch", func(t *testing.T) {
		r := call(t, s, "POST", "/v1/payment_intents", "a", k1, createBody)
		if r.status != 201 || r.body["status"] != "requires_confirmation" || r.body["amount_minor"] != "1999" {
			t.Fatalf("%d %s", r.status, r.raw)
		}
		pi = r.body["id"].(string)
		if r.header.Get("Location") != "/v1/payment_intents/"+pi || r.header.Get("X-Request-Id") == "" || r.header.Get("Cache-Control") != "no-store" {
			t.Fatalf("headers %v", r.header)
		}
		for _, f := range []string{"payment_method_token", "tenant_id", "merchant_id", "policy_version", "provider_account_id"} {
			if _, leaked := r.body[f]; leaked {
				t.Errorf("response exposes %s", f)
			}
		}
		again := call(t, s, "POST", "/v1/payment_intents", "a", k1, createBody)
		if again.status != 201 || again.body["id"] != pi {
			t.Fatalf("replay %d %s", again.status, again.raw)
		}
		changed := strings.Replace(createBody, "1999", "2000", 1)
		if m := call(t, s, "POST", "/v1/payment_intents", "a", k1, changed); m.status != 422 || m.body["code"] != "idempotency_fingerprint_mismatch" {
			t.Fatalf("mismatch %d %s", m.status, m.raw)
		}
	})

	t.Run("confirm returns an operation receipt", func(t *testing.T) {
		r := call(t, s, "POST", "/v1/payment_intents/"+pi+"/confirm", "a", `"33333333-3333-4333-8333-333333333333"`, `{}`)
		if r.status != 202 || r.body["kind"] != "confirm" || r.body["resolution"] != "pending" {
			t.Fatalf("%d %s", r.status, r.raw)
		}
		op := r.body["id"].(string)
		if r.header.Get("Location") != "/v1/operations/"+op {
			t.Fatalf("Location %q", r.header.Get("Location"))
		}
		g := call(t, s, "GET", "/v1/operations/"+op, "a", "", "")
		if g.status != 200 || g.body["payment_intent_id"] != pi {
			t.Fatalf("get op %d %s", g.status, g.raw)
		}
		c := call(t, s, "POST", "/v1/payment_intents/"+pi+"/capture", "a", `"44444444-4444-4444-8444-444444444444"`, `{"amount_minor":"1999"}`)
		if c.status != 409 {
			t.Fatalf("capture while processing: %d %s", c.status, c.raw)
		}
	})

	t.Run("other merchants get a masked 404", func(t *testing.T) {
		for _, path := range []string{"/v1/payment_intents/" + pi} {
			if r := call(t, s, "GET", path, "b", "", ""); r.status != 404 || r.body["code"] != "resource_not_found" {
				t.Fatalf("%s: %d %s", path, r.status, r.raw)
			}
		}
		if r := call(t, s, "GET", "/v1/payment_intents/not-an-id", "a", "", ""); r.status != 404 {
			t.Fatalf("bad id: %d %s", r.status, r.raw)
		}
	})

	t.Run("list is scoped and paginated", func(t *testing.T) {
		for i := range 3 {
			k := `"55555555-5555-4555-8555-00000000000` + string(rune('0'+i)) + `"`
			if r := call(t, s, "POST", "/v1/payment_intents", "a", k, createBody); r.status != 201 {
				t.Fatal(r.raw)
			}
		}
		p1 := call(t, s, "GET", "/v1/payment_intents?limit=2", "a", "", "")
		if p1.status != 200 || len(p1.body["data"].([]any)) != 2 || p1.body["has_more"] != true {
			t.Fatalf("page 1: %s", p1.raw)
		}
		p2 := call(t, s, "GET", "/v1/payment_intents?limit=2&cursor="+p1.body["next_cursor"].(string), "a", "", "")
		if p2.status != 200 || len(p2.body["data"].([]any)) != 2 || p2.body["has_more"] != false {
			t.Fatalf("page 2: %s", p2.raw)
		}
		if other := call(t, s, "GET", "/v1/payment_intents", "b", "", ""); len(other.body["data"].([]any)) != 0 {
			t.Fatalf("other merchant sees data: %s", other.raw)
		}
	})
}

func TestNoAuthenticatorMeansNoAccess(t *testing.T) {
	s := server(t, nil)
	if r := call(t, s, "GET", "/v1/payment_intents", "a", "", ""); r.status != 401 {
		t.Fatalf("unauthenticated handler served data: %d", r.status)
	}
}
