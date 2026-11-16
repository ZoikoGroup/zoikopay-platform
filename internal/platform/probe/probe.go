// Package probe checks HTTP dependencies that need no client library, such
// as the OIDC provider (Keycloak, standing in for Zoiko iD) and the S3-compatible
// evidence store.
package probe

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/health"
)

var httpClient = &http.Client{Timeout: 5 * time.Second}

// HTTP is a dependency that is healthy when GET <base URL from baseEnv><path>
// returns 200. Example: probe.HTTP("oidc", "ZP_OIDC_ISSUER", "/.well-known/openid-configuration").
func HTTP(name, baseEnv, path string) health.Dependency {
	return health.Dependency{
		Name: name,
		Open: func(ctx context.Context) (health.Probe, func(), error) {
			base := os.Getenv(baseEnv)
			u, err := url.Parse(base)
			if base == "" || err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				return nil, nil, fmt.Errorf("%w: %s must be an http(s) URL", health.ErrConfig, baseEnv)
			}
			target := strings.TrimSuffix(base, "/") + path
			check := func(ctx context.Context) error { return get(ctx, target) }
			if err := check(ctx); err != nil {
				return nil, nil, err
			}
			return check, func() {}, nil
		},
	}
}

func get(ctx context.Context, target string) error {
	// target is built from operator configuration (an environment variable
	// validated as an http(s) URL in HTTP), never from request input.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil) //nolint:gosec // G704: URL is operator config, not user input
	if err != nil {
		return err
	}
	resp, err := httpClient.Do(req) //nolint:gosec // G704: URL is operator config, not user input
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: status %d", target, resp.StatusCode)
	}
	return nil
}
