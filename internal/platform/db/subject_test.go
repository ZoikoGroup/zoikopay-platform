package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/platform/db"
)

// An incomplete identity is refused before any transaction starts (fail closed).
func TestInSubjectTxRefusesIncompleteSubject(t *testing.T) {
	for _, s := range []db.Subject{
		{},
		{Issuer: "http://localhost:8180/realms/zoikopay"},
		{Subject: "00000000-0000-4000-8000-000000000002"},
	} {
		called := false
		err := db.InSubjectTx(context.Background(), nil, s, func(pgx.Tx) error { called = true; return nil })
		if !errors.Is(err, db.ErrNoSubject) {
			t.Errorf("InSubjectTx(%+v) err = %v; want ErrNoSubject", s, err)
		}
		if called {
			t.Errorf("InSubjectTx(%+v) ran fn without a full subject", s)
		}
	}
}
