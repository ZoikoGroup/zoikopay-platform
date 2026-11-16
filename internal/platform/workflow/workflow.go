// Package workflow wraps the Temporal client used by deployable D2 execution
// (spec 03-03 §5.1). Workers and workflows are registered by modules later.
package workflow

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	tlog "go.temporal.io/sdk/log"

	"github.com/zoiko/zoikopay/internal/platform/health"
)

// Dependency dials Temporal at the address in addrEnv (host:port) and checks
// that the namespace in nsEnv exists. The client is passed to onOpen, which may be nil.
func Dependency(addrEnv, nsEnv string, log *slog.Logger, onOpen func(client.Client)) health.Dependency {
	return health.Dependency{
		Name: "temporal",
		Open: func(ctx context.Context) (health.Probe, func(), error) {
			addr, ns := os.Getenv(addrEnv), os.Getenv(nsEnv)
			if addr == "" || ns == "" {
				return nil, nil, fmt.Errorf("%w: %s and %s must be set", health.ErrConfig, addrEnv, nsEnv)
			}
			c, err := client.DialContext(ctx, client.Options{
				HostPort:  addr,
				Namespace: ns,
				Logger:    tlog.NewStructuredLogger(log.With("component", "temporal")),
			})
			if err != nil {
				return nil, nil, fmt.Errorf("dial temporal: %w", err)
			}
			if _, err := c.WorkflowService().DescribeNamespace(ctx,
				&workflowservice.DescribeNamespaceRequest{Namespace: ns}); err != nil {
				c.Close()
				return nil, nil, fmt.Errorf("temporal namespace %q: %w", ns, err)
			}
			if onOpen != nil {
				onOpen(c)
			}
			probe := func(ctx context.Context) error {
				_, err := c.CheckHealth(ctx, &client.CheckHealthRequest{})
				return err
			}
			return probe, c.Close, nil
		},
	}
}
