// Command mockpsp is a scripted fake PSP used in tests and local development. It never moves real money.
//
// Skeleton: it connects to its dependencies and serves /healthz, /readyz and
// /livez only. Business routes are added in later milestones.
package main

import (
	"github.com/zoiko/zoikopay/internal/platform/bootstrap"
)

func main() {
	bootstrap.Main(bootstrap.Service{
		Name:        "mockpsp",
		DefaultAddr: ":8090",
		// No dependencies: the mock PSP is self-contained.
	})
}
