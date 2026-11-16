package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/payment/domain"
	"github.com/zoiko/zoikopay/internal/payment/store"
	"github.com/zoiko/zoikopay/internal/platform/db"
)

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

// SweepStats reports one sweeper pass.
type SweepStats struct {
	Examined int
	Changed  int
	Cases    int
}

// EscalateUnresolved opens a recovery case for every operation still PENDING
// or UNKNOWN after olderThan (06-01 §7.3 R5, PI-046, PI-AT-067). It never
// resolves, fails or retries anything: recovery stays inquiry-first through
// BC-04, and resolution needs verified evidence.
//
// olderThan must be supplied: the escalation horizon comes from approved
// partner contracts and 02-04, and is not invented here (OPEN_QUESTIONS Q32).
func (s *Service) EscalateUnresolved(ctx context.Context, olderThan time.Duration, batch int) (SweepStats, error) {
	if olderThan <= 0 {
		return SweepStats{}, errors.New("payment: escalation horizon must be configured")
	}
	return s.sweep(ctx, "OPERATION_RESOLUTION", s.now().Add(-olderThan), batch, func(ctx context.Context, tx pgx.Tx, q *store.Queries, ref string) (bool, bool, error) {
		op, err := q.GetOperation(ctx, ref)
		if err != nil {
			return false, false, err
		}
		if !domain.Resolution(op.Resolution).Unresolved() || op.Resolution == string(domain.ResConflicted) {
			return true, false, nil // resolved, or already under a conflict case
		}
		row, err := q.LockIntentByID(ctx, op.IntentID)
		if err != nil {
			return false, false, err
		}
		detail := fmt.Sprintf("operation %s (%s) still %s after %s; inquiry-first recovery (06-01 §7.3)", op.PublicID, op.Kind, op.Resolution, olderThan)
		if err := s.openCase(ctx, q, row, &op, domain.Decision{Case: domain.CaseUnresolved, Reason: detail}); err != nil {
			return false, false, err
		}
		return true, true, nil
	})
}

// ExpireDue applies business expiry to intents whose expires_at passed
// (06-01 EXPIRE_PRE_CONFIRM / EXPIRE_PROCESSING).
func (s *Service) ExpireDue(ctx context.Context, batch int) (SweepStats, error) {
	return s.sweep(ctx, "INTENT_EXPIRY", s.now(), batch, func(ctx context.Context, tx pgx.Tx, q *store.Queries, ref string) (bool, bool, error) {
		row, err := q.LockIntentByID(ctx, ref)
		if err != nil {
			return false, false, err
		}
		l, err := load(ctx, q, row)
		if err != nil {
			return false, false, err
		}
		d, ok := domain.Expire(l.domain(), s.now())
		if !ok {
			// Nothing applies now (terminal, or REQUIRES_CAPTURE where only the
			// provider's authorization expiry counts).
			return true, false, nil
		}
		if _, err := s.apply(ctx, tx, l, d, applyMeta{actor: "system:expiry", correlationID: "expiry:" + row.PublicID}); err != nil {
			return false, false, err
		}
		return true, d.Case != "", nil
	})
}

// sweep reads due identifiers (cross-tenant, identifiers only) and handles
// each one inside its own tenant transaction.
func (s *Service) sweep(ctx context.Context, kind string, dueBefore time.Time, batch int,
	handle func(context.Context, pgx.Tx, *store.Queries, string) (done bool, cased bool, err error)) (SweepStats, error) {
	if batch <= 0 {
		batch = 100
	}
	due, err := store.New(s.Pool).DueWork(ctx, store.DueWorkParams{Kind: kind, DueBefore: dueBefore, BatchSize: int32(batch)})
	if err != nil {
		return SweepStats{}, fmt.Errorf("read %s schedule: %w", kind, err)
	}
	var st SweepStats
	var errs []error
	for _, w := range due {
		st.Examined++
		t := db.Tenant{Environment: w.Environment, CellID: w.CellID, LegalEntityID: w.LegalEntityID, TenantID: w.TenantID}
		err := db.InTenantTx(ctx, s.Pool, t, func(tx pgx.Tx) error {
			q := store.New(tx)
			done, cased, err := handle(ctx, tx, q, w.RefID)
			if err != nil {
				return err
			}
			if cased {
				st.Cases++
			}
			if done {
				st.Changed++
				now := s.now()
				return q.CompleteWork(ctx, store.CompleteWorkParams{DoneAtUtc: &now, Kind: kind, RefID: w.RefID})
			}
			return nil
		})
		if err != nil {
			errs = append(errs, fmt.Errorf("%s %s: %w", kind, w.RefID, err))
		}
	}
	return st, errors.Join(errs...)
}
