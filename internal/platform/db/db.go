// Package db opens PostgreSQL connection pools for ZoikoPay binaries.
//
// Transactions, tenancy session variables (SET LOCAL) and RLS helpers come
// later. This package never calls a PSP or any other network service.
package db

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/platform/health"
)

// Open creates a pool and verifies it can reach the server.
func Open(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse database config: %w", err)
	}
	// All timestamps are handled in UTC (spec 02-05).
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	cfg.MaxConnLifetime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// Dependency connects to PostgreSQL using the DSN in the environment variable
// envVar (normally ZP_DATABASE_URL). Each deployable logs in as its own
// runtime role (ADR 0002 §2). The pool is passed to onOpen, which may be nil.
func Dependency(envVar string, onOpen func(*pgxpool.Pool)) health.Dependency {
	return health.Dependency{
		Name: "postgres",
		Open: func(ctx context.Context) (health.Probe, func(), error) {
			dsn := os.Getenv(envVar)
			if dsn == "" {
				return nil, nil, fmt.Errorf("%w: %s is not set", health.ErrConfig, envVar)
			}
			if _, err := pgxpool.ParseConfig(dsn); err != nil {
				return nil, nil, fmt.Errorf("%w: %s: %w", health.ErrConfig, envVar, err)
			}
			pool, err := Open(ctx, dsn)
			if err != nil {
				return nil, nil, err
			}
			if onOpen != nil {
				onOpen(pool)
			}
			return pool.Ping, pool.Close, nil
		},
	}
}
