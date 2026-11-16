package idempotency

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zoiko/zoikopay/internal/platform/db"
)

// Scope is the authoritative namespace of a key (04-08 §6.1). Every field is
// derived on the server from the authenticated principal and route, never
// copied from the request body or headers.
type Scope struct {
	Environment   string // "TEST" or "LIVE"
	CellID        string
	LegalEntityID string
	TenantID      string
	MerchantID    string
	ClientID      string // API application / client
	PrincipalID   string // actor or app principal
	APIMajor      int
	Method        string
	RouteTemplate string
	OperationKind string
}

func (s Scope) validate() error {
	var missing []string
	for name, v := range map[string]string{
		"environment": s.Environment, "cell_id": s.CellID, "legal_entity_id": s.LegalEntityID,
		"tenant_id": s.TenantID, "merchant_id": s.MerchantID, "client_id": s.ClientID,
		"principal_id": s.PrincipalID, "method": s.Method, "route_template": s.RouteTemplate,
		"operation_kind": s.OperationKind,
	} {
		if v == "" {
			missing = append(missing, name)
		}
	}
	if s.APIMajor <= 0 {
		missing = append(missing, "api_major")
	}
	if len(missing) > 0 {
		return fmt.Errorf("idempotency scope incomplete: %s", strings.Join(missing, ", "))
	}
	return nil
}

// Status of a registry row.
type Status string

// Registry row statuses. IN_PROGRESS rows never expire by wall-clock alone (04-08 §6.2).
const (
	StatusInProgress Status = "IN_PROGRESS"
	StatusCompleted  Status = "COMPLETED"
)

// Outcome of Reserve.
type Outcome int

// Reserve outcomes and how a route answers them (04-08 §8.1 step 6).
const (
	// New: first time this key is seen. Perform the command in the same tx.
	New Outcome = iota + 1
	// Replay: same key, same request, already completed. Return the stored
	// result; insert no operation and no outbox row.
	Replay
	// InProgress: same key, same request, not finished. 409 operation_in_progress.
	InProgress
	// Mismatch: same key, different request. 422 idempotency_fingerprint_mismatch, zero effects.
	Mismatch
)

// Result describes the registry row after Reserve.
type Result struct {
	Outcome        Outcome
	OperationID    string // stable operation the key is bound to
	ResponseStatus int    // for Replay
	ResourceID     string // for Replay, e.g. the pi_ the command created
}

// Registry is the idempotency_registry table in one module's schema.
type Registry struct {
	Schema string
	Now    func() time.Time // injectable; defaults to time.Now
}

func (r Registry) table() string { return db.Table(r.Schema, "idempotency_registry") }

func (r Registry) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

// Reserve claims key for scope inside tx, binding it to operationID (a fresh
// op_ the caller generated). Lookup is by scope + key digest, never by
// fingerprint; the fingerprint is compared after the row is found (04-08 §3).
//
// Concurrency: two requests with the same key serialize on the unique index.
// The second waits for the first transaction, then sees its committed row
// (or, if the first rolled back, inserts its own).
func (r Registry) Reserve(ctx context.Context, tx pgx.Tx, s Scope, key Key, fingerprint []byte, operationID string) (Result, error) {
	if err := s.validate(); err != nil {
		return Result{}, err
	}
	if len(fingerprint) != 32 {
		return Result{}, errors.New("idempotency: fingerprint must be a SHA-256 digest")
	}
	// The transaction's tenant (set by db.SetTenant) must be the scope's
	// tenant; row-level security would refuse the insert anyway, but this
	// gives a clear error instead of a policy violation.
	var current *string
	if err := tx.QueryRow(ctx, `SELECT current_setting('`+db.SettingTenant+`', true)`).Scan(&current); err != nil {
		return Result{}, fmt.Errorf("read tenant context: %w", err)
	}
	if current == nil || *current != s.TenantID {
		return Result{}, fmt.Errorf("%w: transaction tenant does not match idempotency scope", db.ErrNoTenant)
	}
	now := r.now()
	args := []any{s.Environment, s.CellID, s.LegalEntityID, s.TenantID, s.MerchantID, s.ClientID, s.PrincipalID,
		s.APIMajor, s.Method, s.RouteTemplate, s.OperationKind, key.Digest()}

	var inserted string
	err := tx.QueryRow(ctx, `INSERT INTO `+r.table()+` (
		environment, cell_id, legal_entity_id, tenant_id, merchant_id, client_id, principal_id,
		api_major, method, route_template, operation_kind, key_digest,
		fingerprint_version, request_fingerprint, operation_id, status, created_at_utc, last_seen_at_utc)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'IN_PROGRESS',$16,$16)
		ON CONFLICT DO NOTHING
		RETURNING operation_id`,
		append(args, FingerprintVersion, fingerprint, operationID, now)...).Scan(&inserted)
	switch {
	case err == nil:
		return Result{Outcome: New, OperationID: inserted}, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return Result{}, fmt.Errorf("reserve idempotency key: %w", err)
	}

	// The key exists (or operation_id collided, which a fresh op_ never does).
	var (
		version    string
		stored     []byte
		res        Result
		status     Status
		respStatus *int
		resourceID *string
	)
	err = tx.QueryRow(ctx, `SELECT fingerprint_version, request_fingerprint, operation_id, status, response_status, resource_id
		FROM `+r.table()+`
		WHERE environment=$1 AND cell_id=$2 AND legal_entity_id=$3 AND tenant_id=$4 AND merchant_id=$5
		  AND client_id=$6 AND principal_id=$7 AND api_major=$8 AND method=$9 AND route_template=$10
		  AND operation_kind=$11 AND key_digest=$12
		FOR UPDATE`, args...).Scan(&version, &stored, &res.OperationID, &status, &respStatus, &resourceID)
	if err != nil {
		return Result{}, fmt.Errorf("read idempotency key: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE `+r.table()+` SET last_seen_at_utc=$2 WHERE operation_id=$1`, res.OperationID, now); err != nil {
		return Result{}, fmt.Errorf("touch idempotency key: %w", err)
	}
	if version != FingerprintVersion || !bytes.Equal(stored, fingerprint) {
		// A changed fingerprint version is treated as a mismatch: never a fresh effect.
		res.Outcome = Mismatch
		return res, nil
	}
	if status != StatusCompleted {
		res.Outcome = InProgress
		return res, nil
	}
	res.Outcome = Replay
	if respStatus != nil {
		res.ResponseStatus = *respStatus
	}
	if resourceID != nil {
		res.ResourceID = *resourceID
	}
	return res, nil
}

// ErrNotInProgress is returned by Complete when the operation is unknown or
// already completed.
var ErrNotInProgress = errors.New("idempotency: operation is not in progress")

// Complete records the final result of operationID so retries replay it.
// Call it in the transaction that commits the result. For asynchronous
// commands it is called later, when the operation reaches a stable state.
func (r Registry) Complete(ctx context.Context, tx db.DBTX, operationID string, responseStatus int, resourceID string) error {
	tag, err := tx.Exec(ctx, `UPDATE `+r.table()+`
		SET status='COMPLETED', response_status=$2, resource_id=NULLIF($3,''), last_seen_at_utc=$4
		WHERE operation_id=$1 AND status='IN_PROGRESS'`, operationID, responseStatus, resourceID, r.now())
	if err != nil {
		return fmt.Errorf("complete idempotency key: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("%w: %s", ErrNotInProgress, operationID)
	}
	return nil
}

// TableSQL returns the DDL for this table in schema: the table, tenant
// row-level security and the identity guard. Retention (04-08 §6.2) is not
// approved, so identities are never deleted: the guard refuses DELETE and
// TRUNCATE for every role, and refuses changes to a key's identity (scope,
// digest, fingerprint, operation) or to a completed result.
// Generate a module's migration with `go run ./cmd/migrate scaffold`.
func TableSQL(schema string) string {
	t := db.Table(schema, "idempotency_registry")
	fn := db.Table(schema, "zp_idempotency_guard")
	return `CREATE TABLE ` + t + ` (
    environment         text        NOT NULL CHECK (environment IN ('TEST','LIVE')),
    cell_id             text        NOT NULL,
    legal_entity_id     text        NOT NULL,
    tenant_id           text        NOT NULL,
    merchant_id         text        NOT NULL,
    client_id           text        NOT NULL,
    principal_id        text        NOT NULL,
    api_major           integer     NOT NULL CHECK (api_major > 0),
    method              text        NOT NULL,
    route_template      text        NOT NULL,
    operation_kind      text        NOT NULL,
    key_digest          bytea       NOT NULL CHECK (octet_length(key_digest) = 32),
    fingerprint_version text        NOT NULL,
    request_fingerprint bytea       NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    operation_id        text        NOT NULL UNIQUE,
    status              text        NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
    response_status     integer     NULL CHECK (response_status BETWEEN 100 AND 599),
    resource_id         text        NULL,
    created_at_utc      timestamptz NOT NULL,
    last_seen_at_utc    timestamptz NOT NULL,
    PRIMARY KEY (environment, cell_id, legal_entity_id, tenant_id, merchant_id, client_id, principal_id,
                 api_major, method, route_template, operation_kind, key_digest),
    CHECK ((status = 'COMPLETED') = (response_status IS NOT NULL))
);
CREATE FUNCTION ` + fn + `() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'idempotency identities are never deleted (04-08 §6.2)' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.environment, NEW.cell_id, NEW.legal_entity_id, NEW.tenant_id, NEW.merchant_id, NEW.client_id,
        NEW.principal_id, NEW.api_major, NEW.method, NEW.route_template, NEW.operation_kind, NEW.key_digest,
        NEW.fingerprint_version, NEW.request_fingerprint, NEW.operation_id, NEW.created_at_utc)
       IS DISTINCT FROM
       (OLD.environment, OLD.cell_id, OLD.legal_entity_id, OLD.tenant_id, OLD.merchant_id, OLD.client_id,
        OLD.principal_id, OLD.api_major, OLD.method, OLD.route_template, OLD.operation_kind, OLD.key_digest,
        OLD.fingerprint_version, OLD.request_fingerprint, OLD.operation_id, OLD.created_at_utc) THEN
        RAISE EXCEPTION 'an idempotency identity cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status = 'COMPLETED' AND (NEW.status, NEW.response_status, NEW.resource_id)
       IS DISTINCT FROM (OLD.status, OLD.response_status, OLD.resource_id) THEN
        RAISE EXCEPTION 'a completed idempotency result cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER idempotency_guard BEFORE UPDATE OR DELETE ON ` + t + ` FOR EACH ROW EXECUTE FUNCTION ` + fn + `();
CREATE TRIGGER idempotency_guard_truncate BEFORE TRUNCATE ON ` + t + ` FOR EACH STATEMENT EXECUTE FUNCTION ` + fn + `();
` + db.TenantRLSSQL(schema, "idempotency_registry")
}

// GrantSQL grants the owning deployable's runtime role the least it needs:
// read and insert keys, and update only the result columns. No DELETE.
func GrantSQL(schema, writerRole string) string {
	t := db.Table(schema, "idempotency_registry")
	return `GRANT SELECT, INSERT ON ` + t + ` TO ` + writerRole + `;
GRANT UPDATE (status, response_status, resource_id, last_seen_at_utc) ON ` + t + ` TO ` + writerRole + `;`
}
