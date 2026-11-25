//go:build integration

package authn_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zoiko/zoikopay/internal/platform/authn"
	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
)

// keycloakImage is the Zoiko iD stand-in; keep it in sync with deploy/compose/compose.yaml.
const keycloakImage = "quay.io/keycloak/keycloak:26.4.7"

// realm is the part of deploy/compose/keycloak/zoikopay-realm.json the test
// reads, so no local credential is repeated in this file.
type realm struct {
	Clients []struct {
		ClientID string `json:"clientId"`
		Secret   string `json:"secret"`
	} `json:"clients"`
	Users []struct {
		ID          string `json:"id"`
		Username    string `json:"username"`
		Credentials []struct {
			Value string `json:"value"`
		} `json:"credentials"`
	} `json:"users"`
}

func (r realm) secret(t *testing.T, clientID string) string {
	t.Helper()
	for _, c := range r.Clients {
		if c.ClientID == clientID {
			return c.Secret
		}
	}
	t.Fatalf("client %s not in the realm import", clientID)
	return ""
}

func (r realm) user(t *testing.T, username string) (id, password string) {
	t.Helper()
	for _, u := range r.Users {
		if u.Username == username && len(u.Credentials) > 0 {
			return u.ID, u.Credentials[0].Value
		}
	}
	t.Fatalf("user %s not in the realm import", username)
	return "", ""
}

// TestKeycloakTokens runs the verifier against a real Keycloak (the local
// Zoiko iD stand-in) started from the same image and realm import as Docker
// Compose. Configuration is the only Keycloak-specific part.
func TestKeycloakTokens(t *testing.T) {
	ctx := context.Background()
	realmFile := filepath.Join(dbtest.RepoRoot(t), "deploy", "compose", "keycloak", "zoikopay-realm.json")
	raw, err := os.ReadFile(realmFile) //nolint:gosec // G304: repository file in a test.
	if err != nil {
		t.Fatal(err)
	}
	var rlm realm
	if err := json.Unmarshal(raw, &rlm); err != nil {
		t.Fatal(err)
	}

	ctr, err := testcontainers.Run(ctx, keycloakImage,
		testcontainers.WithCmd("start-dev", "--import-realm"),
		testcontainers.WithFiles(testcontainers.ContainerFile{
			HostFilePath: realmFile, ContainerFilePath: "/opt/keycloak/data/import/zoikopay-realm.json", FileMode: 0o644,
		}),
		testcontainers.WithExposedPorts("8080/tcp"),
		// Keycloak can take over a minute while the rest of the integration
		// suite starts its containers. Both limits default to 60s: the overall
		// deadline (WithWaitStrategy) and the HTTP strategy's own startup timeout.
		testcontainers.WithWaitStrategyAndDeadline(4*time.Minute,
			wait.ForHTTP("/realms/zoikopay/.well-known/openid-configuration").WithPort("8080/tcp").
				WithStartupTimeout(4*time.Minute)),
	)
	testcontainers.CleanupContainer(t, ctr)
	if err != nil {
		t.Fatalf("start keycloak: %v", err)
	}
	base, err := ctr.PortEndpoint(ctx, "8080/tcp", "http")
	if err != nil {
		t.Fatal(err)
	}
	issuer := base + "/realms/zoikopay"
	jwksURL := issuer + "/protocol/openid-connect/certs"

	// The configuration documented in authn.Config matches what Keycloak publishes.
	var discovery struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	getJSON(ctx, t, issuer+"/.well-known/openid-configuration", &discovery)
	if discovery.Issuer != issuer || discovery.JWKSURI != jwksURL {
		t.Fatalf("discovery = %+v; want issuer %s and jwks_uri %s", discovery, issuer, jwksURL)
	}

	v, err := authn.NewVerifier(authn.Config{
		Issuer: issuer, Audience: "zoikopay-gateway", JWKSURL: jwksURL,
		RequiredClaims: map[string]string{"typ": "Bearer"},
		// Loopback http is allowed by default; a remote Docker host needs this.
		AllowInsecureHTTP: true,
		// The production default is 5s; a busy CI host can be slower.
		HTTPClient: testClient,
	})
	if err != nil {
		t.Fatal(err)
	}

	consoleSecret := rlm.secret(t, "zoikopay-console")
	userID, password := rlm.user(t, "ops.agent")
	tokens := tokenRequest(ctx, t, issuer, url.Values{
		"grant_type": {"password"}, "client_id": {"zoikopay-console"}, "client_secret": {consoleSecret},
		"username": {"ops.agent"}, "password": {password}, "scope": {"openid"},
	})

	t.Run("an access token for the gateway verifies", func(t *testing.T) {
		id, err := v.Verify(ctx, tokens.Access)
		if err != nil {
			t.Fatalf("verify: %v", err)
		}
		if id.Issuer != issuer || id.Subject != userID || !slices.Contains(id.Audience, "zoikopay-gateway") {
			t.Errorf("identity = %+v; want issuer %s, subject %s, audience zoikopay-gateway", id, issuer, userID)
		}
		if id.SessionID == "" {
			t.Errorf("Keycloak's sid claim was not copied into SessionID")
		}
		if lifetime := id.ExpiresAt.Sub(id.IssuedAt); lifetime != 5*time.Minute {
			t.Errorf("token lifetime %s; want the realm's 5m", lifetime)
		}
	})

	t.Run("ID and refresh tokens are refused", func(t *testing.T) {
		_, err := v.Verify(ctx, tokens.ID) // aud zoikopay-console, typ ID
		wantInvalid(t, "ID token", err)
		_, err = v.Verify(ctx, tokens.Refresh) // HMAC-signed by Keycloak
		wantInvalid(t, "refresh token", err)
	})

	t.Run("a token minted for another client is refused", func(t *testing.T) {
		// The gateway's own service-account token has no zoikopay-gateway audience.
		svc := tokenRequest(ctx, t, issuer, url.Values{
			"grant_type": {"client_credentials"}, "client_id": {"zoikopay-gateway"},
			"client_secret": {rlm.secret(t, "zoikopay-gateway")},
		})
		_, err := v.Verify(ctx, svc.Access)
		wantInvalid(t, "client-credentials token without the gateway audience", err)
	})

	t.Run("a modified token is refused", func(t *testing.T) {
		parts := strings.Split(tokens.Access, ".")
		payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
		forged := strings.Replace(string(payload), userID, "00000000-0000-4000-8000-000000000001", 1)
		parts[1] = base64.RawURLEncoding.EncodeToString([]byte(forged))
		_, err := v.Verify(ctx, strings.Join(parts, "."))
		wantInvalid(t, "subject changed to super.admin's", err)
	})

	t.Run("a verifier for another realm refuses the token", func(t *testing.T) {
		other, err := authn.NewVerifier(authn.Config{
			Issuer: base + "/realms/other", Audience: "zoikopay-gateway", JWKSURL: jwksURL, AllowInsecureHTTP: true,
			HTTPClient: testClient,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, err = other.Verify(ctx, tokens.Access)
		wantInvalid(t, "issuer mismatch", err)
		if errors.Is(err, authn.ErrKeysUnavailable) {
			t.Errorf("issuer mismatch must not look like an outage")
		}
	})
}

type tokenSet struct {
	Access  string `json:"access_token"`
	ID      string `json:"id_token"`
	Refresh string `json:"refresh_token"`
}

// testClient talks to the Keycloak test container only.
var testClient = &http.Client{Timeout: 30 * time.Second}

func tokenRequest(ctx context.Context, t *testing.T, issuer string, form url.Values) tokenSet {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, issuer+"/protocol/openid-connect/token", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	var ts tokenSet
	status := do(t, req, &ts)
	if status != http.StatusOK || ts.Access == "" {
		t.Fatalf("token request (%s): status %d", form.Get("grant_type"), status)
	}
	return ts
}

func getJSON(ctx context.Context, t *testing.T, u string, out any) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		t.Fatal(err)
	}
	if status := do(t, req, out); status != http.StatusOK {
		t.Fatalf("GET %s: status %d", u, status)
	}
}

// do sends req to the test container and decodes a JSON body into out.
func do(t *testing.T, req *http.Request, out any) int {
	t.Helper()
	resp, err := testClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode
}
