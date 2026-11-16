// Command execution is deployable D2 (B: Payment Execution): BC-03 payment lifecycle and BC-04 provider connectivity, plus the Temporal worker.
//
// Skeleton: it connects to its dependencies and serves /healthz, /readyz and
// /livez only. Business routes are added in later milestones.
package main

import (
	"log/slog"

	"github.com/zoiko/zoikopay/internal/platform/bootstrap"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/health"
	"github.com/zoiko/zoikopay/internal/platform/workflow"
)

func main() {
	bootstrap.Main(bootstrap.Service{
		Name:        "execution",
		DefaultAddr: ":8081",
		Dependencies: func(log *slog.Logger) []health.Dependency {
			return []health.Dependency{
				db.Dependency("ZP_DATABASE_URL", nil), // role zp_execution
				workflow.Dependency("ZP_TEMPORAL_ADDR", "ZP_TEMPORAL_NAMESPACE", log, nil),
			}
		},
	})
}
