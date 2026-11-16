// Command finance is deployable D3 (C: Financial Integrity): BC-05 ledger, BC-06 reconciliation and BC-07 billing.
//
// Skeleton: it connects to its dependencies and serves /healthz, /readyz and
// /livez only. Business routes are added in later milestones.
package main

import (
	"log/slog"

	"github.com/zoiko/zoikopay/internal/platform/bootstrap"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/health"
)

func main() {
	bootstrap.Main(bootstrap.Service{
		Name:        "finance",
		DefaultAddr: ":8082",
		Dependencies: func(*slog.Logger) []health.Dependency {
			return []health.Dependency{
				db.Dependency("ZP_DATABASE_URL", nil), // role zp_finance
			}
		},
	})
}
