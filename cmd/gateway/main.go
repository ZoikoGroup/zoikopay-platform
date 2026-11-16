// Command gateway is deployable D1 (A: API and Merchant Control): merchant API ingress, BC-01 and the BC-02 edge enforcement adapter.
//
// Skeleton: it connects to its dependencies and serves /healthz, /readyz and
// /livez only. Business routes are added in later milestones.
package main

import (
	"log/slog"

	"github.com/zoiko/zoikopay/internal/platform/bootstrap"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/health"
	"github.com/zoiko/zoikopay/internal/platform/probe"
)

func main() {
	bootstrap.Main(bootstrap.Service{
		Name:        "gateway",
		DefaultAddr: ":8080",
		Dependencies: func(*slog.Logger) []health.Dependency {
			return []health.Dependency{
				db.Dependency("ZP_DATABASE_URL", nil), // role zp_gateway
				probe.HTTP("oidc", "ZP_OIDC_ISSUER", "/.well-known/openid-configuration"),
			}
		},
	})
}
