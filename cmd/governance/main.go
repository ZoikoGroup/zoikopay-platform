// Command governance is deployable D4 (D: Governance and Intelligence): BC-02 policy authority, BC-08 risk and governance, BC-09 notifications.
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
		Name:        "governance",
		DefaultAddr: ":8083",
		Dependencies: func(*slog.Logger) []health.Dependency {
			return []health.Dependency{
				db.Dependency("ZP_DATABASE_URL", nil), // role zp_governance
				probe.HTTP("oidc", "ZP_OIDC_ISSUER", "/.well-known/openid-configuration"),
				probe.HTTP("evidence_store", "ZP_S3_ENDPOINT", "/minio/health/ready"),
			}
		},
	})
}
