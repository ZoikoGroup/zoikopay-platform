package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DBTX is what the platform stores need: satisfied by *pgxpool.Pool, *pgx.Conn
// and pgx.Tx. Stores that must be atomic with business writes take a pgx.Tx.
type DBTX interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Beginner starts transactions (*pgxpool.Pool and *pgx.Conn implement it).
type Beginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// InTx runs fn in one transaction: commit when fn returns nil, roll back
// otherwise (and on panic). Business writes, the idempotency reservation and
// outbox rows go through the same tx so they commit or vanish together.
func InTx(ctx context.Context, b Beginner, fn func(pgx.Tx) error) error {
	if err := pgx.BeginFunc(ctx, b, fn); err != nil {
		return fmt.Errorf("transaction: %w", err)
	}
	return nil
}

// Table returns the safely quoted "schema"."table" name. Schema names come
// from module configuration, never from requests, but are quoted regardless.
func Table(schema, table string) string {
	return pgx.Identifier{schema, table}.Sanitize()
}
