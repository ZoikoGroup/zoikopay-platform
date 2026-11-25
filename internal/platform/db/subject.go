package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Subject is the verified identity of the caller: the token's issuer and
// subject (02-02 §2.2 "sub, issuer"). It works with any OIDC issuer; the pair,
// not the subject alone, identifies a person, so equal subjects from two
// issuers never match each other. It is set only after the token has been
// verified on the server, never from request fields.
type Subject struct {
	Issuer  string // the token's iss, e.g. http://localhost:8180/realms/zoikopay
	Subject string // the token's sub
}

// Session settings read by the subject row-level security policies. Like the
// tenant settings, they last only until the end of the transaction.
const (
	SettingSubjectIssuer = "zp.subject_issuer"
	SettingSubject       = "zp.subject"
)

// ErrNoSubject is returned when a subject transaction is started without a full identity.
var ErrNoSubject = errors.New("subject context is incomplete")

func (s Subject) validate() error {
	if s.Issuer == "" || s.Subject == "" {
		return fmt.Errorf("%w: issuer and subject are both required", ErrNoSubject)
	}
	return nil
}

// SetSubject binds tx to s. Tables with a subject policy (for example
// merchant.memberships) then also show s's own rows, so the server can find
// which tenants a caller belongs to before any tenant is known. It never
// grants writes: those still need a tenant (SetTenant).
func SetSubject(ctx context.Context, tx pgx.Tx, s Subject) error {
	if err := s.validate(); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `SELECT set_config($1, $2, true), set_config($3, $4, true)`,
		SettingSubjectIssuer, s.Issuer, SettingSubject, s.Subject)
	if err != nil {
		return fmt.Errorf("set subject context: %w", err)
	}
	return nil
}

// InSubjectTx is InTx with the subject context set before fn runs.
func InSubjectTx(ctx context.Context, b Beginner, s Subject, fn func(pgx.Tx) error) error {
	if err := s.validate(); err != nil {
		return err
	}
	return InTx(ctx, b, func(tx pgx.Tx) error {
		if err := SetSubject(ctx, tx, s); err != nil {
			return err
		}
		return fn(tx)
	})
}
