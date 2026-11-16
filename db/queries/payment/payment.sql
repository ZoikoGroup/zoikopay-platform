-- BC-03 queries (sqlc). Every query runs inside a tenant transaction
-- (db.InTenantTx), so row-level security scopes it to one tenant; merchant
-- and environment are additionally matched where a merchant reads.

-- name: InsertIntent :exec
INSERT INTO payment.payment_intents (
    intent_id, public_id, environment, tenant_id, merchant_id, cell_id, legal_entity_id, merchant_reference,
    amount_requested_minor, currency, currency_spec_version, capture_method, payment_method_token_ref,
    intent_status, status_reason_code, aggregate_version, policy_version, expires_at_utc, created_at_utc, updated_at_utc)
VALUES (
    @intent_id, @public_id, @environment, @tenant_id, @merchant_id, @cell_id, @legal_entity_id, sqlc.narg(merchant_reference),
    @amount_requested_minor, @currency, @currency_spec_version, @capture_method, @payment_method_token_ref,
    @intent_status, sqlc.narg(status_reason_code), @aggregate_version, @policy_version, sqlc.narg(expires_at_utc), @created_at_utc, @created_at_utc);

-- name: LockIntentByPublicID :one
SELECT * FROM payment.payment_intents
WHERE public_id = @public_id AND merchant_id = @merchant_id AND environment = @environment
FOR UPDATE;

-- name: LockIntentByID :one
SELECT * FROM payment.payment_intents WHERE intent_id = @intent_id FOR UPDATE;

-- name: GetIntentByPublicID :one
SELECT * FROM payment.payment_intents
WHERE public_id = @public_id AND merchant_id = @merchant_id AND environment = @environment;

-- name: ListIntents :many
SELECT * FROM payment.payment_intents
WHERE merchant_id = @merchant_id AND environment = @environment AND public_id > @after_public_id
ORDER BY public_id
LIMIT @page_size;

-- name: UpdateIntent :execrows
-- Compare-and-swap on aggregate_version (06-01 PI-INV-08).
UPDATE payment.payment_intents SET
    payment_method_token_ref = sqlc.narg(payment_method_token_ref),
    intent_status = @intent_status,
    status_reason_code = sqlc.narg(status_reason_code),
    aggregate_version = @new_version,
    active_operation_id = sqlc.narg(active_operation_id),
    latest_operation_id = sqlc.narg(latest_operation_id),
    authorized_minor = @authorized_minor,
    captured_minor = @captured_minor,
    reserved_capture_minor = @reserved_capture_minor,
    policy_version = @policy_version,
    cancel_requested_at_utc = sqlc.narg(cancel_requested_at_utc),
    expiry_flagged_at_utc = sqlc.narg(expiry_flagged_at_utc),
    frozen_at_utc = sqlc.narg(frozen_at_utc),
    action_ref = sqlc.narg(action_ref),
    action_expires_at_utc = sqlc.narg(action_expires_at_utc),
    updated_at_utc = @updated_at_utc
WHERE intent_id = @intent_id AND aggregate_version = @expected_version;

-- name: InsertOperation :exec
INSERT INTO payment.payment_operations (
    operation_id, public_id, intent_id, tenant_id, kind, economic_effect_id, requested_minor, currency,
    resolution, policy_version, created_at_utc)
VALUES (@operation_id, @public_id, @intent_id, @tenant_id, @kind, @economic_effect_id, @requested_minor, @currency,
    'PENDING', @policy_version, @created_at_utc);

-- name: GetOperation :one
SELECT * FROM payment.payment_operations WHERE operation_id = @operation_id;

-- name: GetOperationByPublicID :one
SELECT o.* FROM payment.payment_operations o
JOIN payment.payment_intents i ON i.intent_id = o.intent_id
WHERE o.public_id = @public_id AND i.merchant_id = @merchant_id AND i.environment = @environment;

-- name: FindOperationByPublicID :one
SELECT * FROM payment.payment_operations WHERE public_id = @public_id;

-- name: UpdateOperationResolution :exec
UPDATE payment.payment_operations SET resolution = @resolution, resolved_at_utc = sqlc.narg(resolved_at_utc)
WHERE operation_id = @operation_id;

-- name: InsertAttempt :exec
INSERT INTO payment.payment_attempts (attempt_id, operation_id, tenant_id, provider_instruction_key, attempt_status, created_at_utc, updated_at_utc)
VALUES (@attempt_id, @operation_id, @tenant_id, @provider_instruction_key, 'RESERVED', @created_at_utc, @created_at_utc);

-- name: GetAttemptByOperation :one
SELECT * FROM payment.payment_attempts WHERE operation_id = @operation_id;

-- name: UpdateAttempt :exec
UPDATE payment.payment_attempts SET provider_account_id = sqlc.narg(provider_account_id), attempt_status = @attempt_status, updated_at_utc = @updated_at_utc
WHERE attempt_id = @attempt_id;

-- name: InsertObservation :execrows
INSERT INTO payment.provider_observations (
    observation_id, tenant_id, event_id, operation_id, operation_public_id, outcome, source_channel,
    provider_account_id, provider_reference, amount_minor, currency, evidence_digest,
    observed_at_utc, recorded_at_utc, disposition, disposition_reason)
VALUES (@observation_id, @tenant_id, @event_id, sqlc.narg(operation_id), @operation_public_id, @outcome, @source_channel,
    sqlc.narg(provider_account_id), sqlc.narg(provider_reference), sqlc.narg(amount_minor), sqlc.narg(currency), @evidence_digest,
    @observed_at_utc, @recorded_at_utc, @disposition, sqlc.narg(disposition_reason))
ON CONFLICT (observation_id) DO NOTHING;

-- name: InsertTransition :exec
INSERT INTO payment.intent_transitions (
    transition_id, intent_id, tenant_id, aggregate_version, input, from_status, to_status,
    operation_id, observation_id, actor, policy_version, reason_code, correlation_id, recorded_at_utc)
VALUES (@transition_id, @intent_id, @tenant_id, @aggregate_version, @input, sqlc.narg(from_status), @to_status,
    sqlc.narg(operation_id), sqlc.narg(observation_id), @actor, sqlc.narg(policy_version), sqlc.narg(reason_code),
    @correlation_id, @recorded_at_utc);

-- name: ListTransitions :many
SELECT * FROM payment.intent_transitions WHERE intent_id = @intent_id ORDER BY aggregate_version;

-- name: InsertCommandLog :exec
INSERT INTO payment.command_log (
    command_log_id, tenant_id, merchant_id, command, intent_public_id, operation_public_id,
    outcome, problem_code, actor, request_id, recorded_at_utc)
VALUES (@command_log_id, @tenant_id, @merchant_id, @command, sqlc.narg(intent_public_id), sqlc.narg(operation_public_id),
    @outcome, sqlc.narg(problem_code), @actor, @request_id, @recorded_at_utc);

-- name: OpenRecoveryCase :execrows
INSERT INTO payment.recovery_cases (case_id, tenant_id, intent_id, operation_id, reason, status, detail, opened_at_utc)
VALUES (@case_id, @tenant_id, @intent_id, sqlc.narg(operation_id), @reason, 'OPEN', @detail, @opened_at_utc)
ON CONFLICT DO NOTHING;

-- name: ScheduleWork :exec
INSERT INTO payment.work_schedule (kind, ref_id, environment, tenant_id, cell_id, legal_entity_id, due_at_utc)
VALUES (@kind, @ref_id, @environment, @tenant_id, @cell_id, @legal_entity_id, @due_at_utc)
ON CONFLICT (kind, ref_id) DO NOTHING;

-- name: CompleteWork :exec
UPDATE payment.work_schedule SET done_at_utc = @done_at_utc
WHERE kind = @kind AND ref_id = @ref_id AND done_at_utc IS NULL;

-- name: DueWork :many
-- Cross-tenant by design: identifiers only (ADR 0006 §6).
SELECT kind, ref_id, environment, tenant_id, cell_id, legal_entity_id, due_at_utc FROM payment.work_schedule
WHERE kind = @kind AND done_at_utc IS NULL AND due_at_utc <= @due_before
ORDER BY due_at_utc
LIMIT @batch_size;
