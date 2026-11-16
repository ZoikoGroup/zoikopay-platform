// Command outbox-relay is the polling relay that publishes committed outbox rows to their consumers.
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
		Name:        "outbox-relay",
		DefaultAddr: ":8084",
		Dependencies: func(*slog.Logger) []health.Dependency {
			return []health.Dependency{
				db.Dependency("ZP_DATABASE_URL", nil), // role zp_relay
			}
		},
	})
}
