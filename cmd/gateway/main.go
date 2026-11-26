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
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/governance"
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

// envAuditDatabase connects as zp_audit, a separate role from the gateway's own,
// which may only INSERT and SELECT the audit log (OPEN_QUESTIONS Q38 38.2, 38.3).
const envAuditDatabase = "ZP_AUDIT_DATABASE_URL"

// Grant administration lifetimes (Go durations, for example 72h). Both are
// required and have no default (Q36 36.10, OPEN_QUESTIONS Q40).
const (
	envInvitationTTL = "ZP_INVITATION_TTL"
	envRequestTTL    = "ZP_ACCESS_REQUEST_TTL"
)

// requiredDuration reads a positive duration from the environment.
func requiredDuration(name string) (time.Duration, error) {
	v := os.Getenv(name)
	if v == "" {
		return 0, fmt.Errorf("%s is required (no default)", name)
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration such as 72h", name)
	}
	return d, nil
}

func main() {
	var pool *pgxpool.Pool      // role zp_gateway; set when the database connects
	var auditPool *pgxpool.Pool // role zp_audit: append-only audit log (OPEN_QUESTIONS Q38)
	bootstrap.Main(bootstrap.Service{
		Name:        "gateway",
		DefaultAddr: ":8080",
		Dependencies: func(*slog.Logger) []health.Dependency {
			return []health.Dependency{
				db.Dependency("ZP_DATABASE_URL", func(p *pgxpool.Pool) { pool = p }),
				{Name: "audit_postgres", Open: db.Dependency(envAuditDatabase, func(p *pgxpool.Pool) { auditPool = p }).Open},
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
			invitationTTL, err := requiredDuration(envInvitationTTL)
			if err != nil {
				return err
			}
			requestTTL, err := requiredDuration(envRequestTTL)
			if err != nil {
				return err
			}
			if err := merchanthttp.Mount(s.Mux(), merchanthttp.Deps{Pool: pool, Verifier: verifier, Resolver: resolver, Log: log,
				Audit: governance.NewAuditLog(auditPool), Environment: os.Getenv(envEnvironment),
				InvitationTTL: invitationTTL, RequestTTL: requestTTL}); err != nil {
				return err
			}
			log.Info("public API mounted", "environment", os.Getenv(envEnvironment), "issuer", cfg.Issuer, "audience", cfg.Audience,
				"invitation_ttl", invitationTTL.String(), "access_request_ttl", requestTTL.String())
			return nil
		},
	})
}
