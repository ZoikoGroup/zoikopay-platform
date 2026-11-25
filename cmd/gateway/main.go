// Command gateway is deployable D1 (A: API and Merchant Control): merchant API ingress, BC-01 and the BC-02 edge enforcement adapter.
//
// It serves /healthz, /readyz and /livez, and the public API under /v1
// (api/openapi/public.v1.yaml). Every /v1 request needs an access token from
// the configured issuer (ADR 0007, ZP_OIDC_*); tenant and role come only from
// merchant.memberships (OPEN_QUESTIONS Q36, Q37).
package main

import (
	"fmt"
	"log/slog"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

	merchanthttp "github.com/zoiko/zoikopay/internal/merchant/http"
	"github.com/zoiko/zoikopay/internal/merchant/store"
	"github.com/zoiko/zoikopay/internal/platform/authn"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/bootstrap"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/health"
	"github.com/zoiko/zoikopay/internal/platform/httpserver"
	"github.com/zoiko/zoikopay/internal/platform/probe"
)

// envEnvironment names the deployment's environment, TEST or LIVE. It is
// required and has no default (Q37 37.14).
const envEnvironment = "ZP_ENVIRONMENT"

func main() {
	var pool *pgxpool.Pool // role zp_gateway; set when the database connects
	bootstrap.Main(bootstrap.Service{
		Name:        "gateway",
		DefaultAddr: ":8080",
		Dependencies: func(*slog.Logger) []health.Dependency {
			return []health.Dependency{
				db.Dependency("ZP_DATABASE_URL", func(p *pgxpool.Pool) { pool = p }),
				probe.HTTP("oidc", "ZP_OIDC_ISSUER", "/.well-known/openid-configuration"),
			}
		},
		Register: func(s *httpserver.Server, log *slog.Logger) error {
			cfg, err := authn.ConfigFromEnv()
			if err != nil {
				return err
			}
			verifier, err := authn.NewVerifier(cfg)
			if err != nil {
				return err
			}
			resolver, err := authz.NewResolver(store.NewGrantSource(pool), os.Getenv(envEnvironment), nil)
			if err != nil {
				return fmt.Errorf("%s: %w", envEnvironment, err)
			}
			merchanthttp.Mount(s.Mux(), merchanthttp.Deps{Pool: pool, Verifier: verifier, Resolver: resolver, Log: log})
			log.Info("public API mounted", "environment", os.Getenv(envEnvironment), "issuer", cfg.Issuer, "audience", cfg.Audience)
			return nil
		},
	})
}
