//go:build integration

package app_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zoiko/zoikopay/internal/payment/app"
	"github.com/zoiko/zoikopay/internal/payment/events"
	"github.com/zoiko/zoikopay/internal/platform/apierror"
	"github.com/zoiko/zoikopay/internal/platform/clock"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/db/dbtest"
	"github.com/zoiko/zoikopay/internal/platform/idempotency"
	"github.com/zoiko/zoikopay/internal/platform/ids"
	"github.com/zoiko/zoikopay/internal/platform/migrate"
	"github.com/zoiko/zoikopay/internal/platform/money"
	"github.com/zoiko/zoikopay/internal/platform/outbox"
)

// policy is a test double of BC-02's enforcement adapter.
type policy struct {
	mu   sync.Mutex
	deny bool
	down bool
}

func (p *policy) Decide(context.Context, app.Scope, app.Action, app.PolicyRequest) (app.PolicyDecision, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.down {
		return app.PolicyDecision{}, errors.New("policy service unreachable")
	}
	if p.deny {
		return app.PolicyDecision{Allowed: false, PolicyVersion: "policy_test_1", ReasonCode: "CELL_SUSPENDED"}, nil
	}
	return app.PolicyDecision{Allowed: true, PolicyVersion: "policy_test_1"}, nil
}

// vault accepts tok_* references except tok_bad.
type vault struct{}

func (vault) Verify(_ context.Context, _ app.Scope, ref string) error {
	if !strings.HasPrefix(ref, "tok_") || ref == "tok_bad" {
		return app.ErrTokenRejected
	}
	return nil
}

type env struct {
	t     *testing.T
	pg    *dbtest.Instance
	svc   *app.Service
	pol   *policy
	clk   *clock.Fake
	exec  *pgxpool.Pool
	relay *pgxpool.Pool
	super *pgxpool.Pool
}

// setup applies the real db/migrations through the approved runner, exactly
// as `make migrate` does, then connects as the runtime roles.
func setup(t *testing.T) *env {
	t.Helper()
	pg := dbtest.Start(t)
	r := migrate.Runner{Pool: pg.Pool(t, "zp_migrator"), Source: os.DirFS(filepath.Join(dbtest.RepoRoot(t), "db", "migrations"))}
	if _, err := r.Up(context.Background()); err != nil {
		t.Fatalf("apply real migrations: %v", err)
	}
	e := &env{t: t, pg: pg, pol: &policy{}, clk: clock.NewFake(time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)),
		exec: pg.Pool(t, "zp_execution"), relay: pg.Pool(t, "zp_relay"), super: pg.Pool(t, "postgres")}
	e.svc = &app.Service{Pool: e.exec, Eligibility: e.pol, Vault: vault{}, Now: e.clk.Now}
	return e
}

func scope(tenant, merchant string) app.Scope {
	return app.Scope{Environment: "TEST", CellID: "cell_uk_01", LegalEntityID: "le_uk", TenantID: tenant, MerchantID: merchant,
		ClientID: "app_1", PrincipalID: "sub_merchant_ops", RequestID: "req_1", CorrelationID: "cor_1"}
}

var A = scope("ten_a", "mer_a")

func key(t *testing.T) idempotency.Key {
	t.Helper()
	k, err := idempotency.ParseHeader([]string{`"` + uuid4() + `"`})
	if err != nil {
		t.Fatal(err)
	}
	return k
}

var uuidMu sync.Mutex
var uuidN int

func uuid4() string {
	uuidMu.Lock()
	defer uuidMu.Unlock()
	uuidN++
	return fmt.Sprintf("%08x-0000-4000-8000-%012x", uuidN, time.Now().UnixNano()&0xffffffffffff)
}

func create(t *testing.T, e *env, sc app.Scope, method string) app.IntentView {
	t.Helper()
	res, err := e.svc.CreateIntent(context.Background(), sc, key(t), app.CreateRequest{Amount: 1999, Currency: "GBP",
		CaptureMethod: method, PaymentMethodToken: "tok_visa_1"})
	if err != nil || res.Status != 201 || res.Intent.Status != "requires_confirmation" {
		t.Fatalf("create = %+v, %v", res, err)
	}
	return *res.Intent
}

func confirm(t *testing.T, e *env, sc app.Scope, pi string) app.OperationView {
	t.Helper()
	res, err := e.svc.ConfirmIntent(context.Background(), sc, key(t), pi, app.ConfirmRequest{})
	if err != nil || res.Status != 202 || res.Op.Kind != "confirm" || res.Op.Resolution != "pending" {
		t.Fatalf("confirm = %+v, %v", res, err)
	}
	return *res.Op
}

func code(err error) apierror.Code {
	var p *apierror.Problem
	if errors.As(err, &p) {
		return p.Code
	}
	return ""
}

// observe plays BC-04: one normalized provider.outcome.observed.v1 event.
type obs struct {
	opID, outcome, account, channel string
	amount                          *money.Minor
	retry                           bool
	observationID                   string
	tenant                          string
}

func (e *env) observe(o obs) error {
	e.t.Helper()
	if o.account == "" {
		o.account = "psp_acct_uk_1"
	}
	if o.channel == "" {
		o.channel = "WEBHOOK"
	}
	if o.observationID == "" {
		o.observationID = ids.NewInternal()
	}
	if o.tenant == "" {
		o.tenant = "ten_a"
	}
	cur := ""
	if o.amount != nil {
		cur = "GBP"
	}
	data := events.OutcomeObserved{ObservationID: o.observationID, OperationID: o.opID, Outcome: o.outcome,
		SourceChannel: o.channel, ProviderAccountID: o.account, Amount: o.amount, Currency: cur, RetryEligible: o.retry,
		ObservedAt: e.clk.Now(), EvidenceDigest: hex.EncodeToString(digest(o.observationID)), Environment: "TEST"}
	return e.deliver(events.TypeOutcomeObserved, o.tenant, o.opID, data)
}

func (e *env) dispatched(opID, attemptID, key, account string) error {
	return e.deliver(events.TypeAttemptDispatched, "ten_a", opID, events.AttemptDispatched{OperationID: opID, AttemptID: attemptID,
		ProviderInstructionKey: key, ProviderAccountID: account, DispatchedAt: e.clk.Now(), Environment: "TEST"})
}

func (e *env) deliver(typ, tenant, subject string, data any) error {
	b, _ := json.Marshal(data)
	ev := outbox.Event{SpecVersion: "1.0", ID: ids.Generator{}.NewEventID(), Source: "/zoikopay/cell_uk_01/bc04", Type: typ,
		Subject: "operation/" + subject, Time: e.clk.Now(), DataContentType: "application/json", DataSchema: "urn:zoikopay:schema:" + typ,
		TenantID: tenant, CellID: "cell_uk_01", LegalEntityID: "le_uk", AggregateID: subject, AggregateVersion: 1,
		CorrelationID: "cor_bc04", Classification: outbox.RestrictedFinancial, RecordedAt: e.clk.Now(), Data: b}
	env, _ := json.Marshal(ev)
	return e.svc.HandleEvent(context.Background(), env)
}

func digest(s string) []byte { h := sha256.Sum256([]byte(s)); return h[:] }

func minor(v int64) *money.Minor { m := money.Minor(v); return &m }

// scan runs one query as zp_execution in tenant A's context and scans it.
func (e *env) scan(sql string, args []any, dest ...any) {
	e.t.Helper()
	err := db.InTenantTx(context.Background(), e.exec, db.Tenant{Environment: "TEST", CellID: "cell_uk_01", LegalEntityID: "le_uk", TenantID: "ten_a"},
		func(tx pgx.Tx) error { return tx.QueryRow(context.Background(), sql, args...).Scan(dest...) })
	if err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
}

func (e *env) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	e.scan(sql, args, &n)
	return n
}

// attempt returns the attempt id and instruction key of a public operation.
func (e *env) attempt(opID string) (string, string) {
	e.t.Helper()
	var a, k string
	e.scan(`SELECT a.attempt_id::text, a.provider_instruction_key::text FROM payment.payment_attempts a
		JOIN payment.payment_operations o ON o.operation_id = a.operation_id WHERE o.public_id = $1`, []any{opID}, &a, &k)
	return a, k
}

func (e *env) get(sc app.Scope, pi string) app.IntentView {
	e.t.Helper()
	v, err := e.svc.GetIntent(context.Background(), sc, pi)
	if err != nil {
		e.t.Fatal(err)
	}
	return v
}

func (e *env) outboxCount(typ string) int {
	e.t.Helper()
	var n int
	if err := e.relay.QueryRow(context.Background(), `SELECT count(*) FROM payment.outbox_events WHERE event_type = $1`, typ).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func sqlState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	if err != nil {
		return "error:" + err.Error()
	}
	return ""
}
