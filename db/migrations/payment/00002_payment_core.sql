-- +goose Up
-- BC-03 Payment Intent & Lifecycle core tables (06-01 §3, §9; ADR 0006).
-- Writer: zp_execution (deployable D2). Every table is tenant-isolated with
-- forced row-level security; history tables are append-only; DELETE and
-- TRUNCATE are refused for every role, including the owner.
-- +goose StatementBegin

-- Guard shared by the append-only tables.
CREATE FUNCTION payment.zp_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

-- Guard against deletion only (tables whose rows may be updated under rules).
CREATE FUNCTION payment.zp_no_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------------------
-- payment_intents: the aggregate root (06-01 §3.1).
CREATE TABLE payment.payment_intents (
    intent_id               uuid        PRIMARY KEY CHECK (uuid_extract_version(intent_id) = 7),
    public_id               text        NOT NULL UNIQUE
                                        CHECK (public_id ~ '^pi_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$'),
    environment             text        NOT NULL CHECK (environment IN ('TEST','LIVE')),
    tenant_id               text        NOT NULL,
    merchant_id             text        NOT NULL,
    cell_id                 text        NOT NULL,
    legal_entity_id         text        NOT NULL, -- operating entity (06-01 PI-INV-01)
    merchant_reference      text        NULL CHECK (length(merchant_reference) BETWEEN 1 AND 128),
    amount_requested_minor  bigint      NOT NULL CHECK (amount_requested_minor > 0)
                                        CHECK (amount_requested_minor BETWEEN -999999999999999 AND 999999999999999),
    currency                text        NOT NULL CHECK (currency IN ('EUR', 'GBP', 'USD')),
    currency_spec_version   text        NOT NULL,
    capture_method          text        NOT NULL CHECK (capture_method IN ('AUTOMATIC','MANUAL')),
    payment_method_token_ref text       NULL CHECK (length(payment_method_token_ref) BETWEEN 1 AND 256),
    intent_status           text        NOT NULL CHECK (intent_status IN (
                                            'REQUIRES_PAYMENT_METHOD','REQUIRES_CONFIRMATION','REQUIRES_CUSTOMER_ACTION',
                                            'PROCESSING','REQUIRES_CAPTURE','PARTIALLY_CAPTURED',
                                            'SUCCEEDED','FAILED','CANCELED','EXPIRED')),
    status_reason_code      text        NULL,
    aggregate_version       bigint      NOT NULL CHECK (aggregate_version > 0),
    active_operation_id     uuid        NULL,
    latest_operation_id     uuid        NULL,
    authorized_minor        bigint      NOT NULL DEFAULT 0 CHECK (authorized_minor >= 0),
    captured_minor          bigint      NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
    reserved_capture_minor  bigint      NOT NULL DEFAULT 0 CHECK (reserved_capture_minor >= 0),
    policy_version          text        NOT NULL,
    cancel_requested_at_utc timestamptz NULL,
    expiry_flagged_at_utc   timestamptz NULL,
    frozen_at_utc           timestamptz NULL, -- set when evidence conflicts (06-01 §7.2): no new effects
    action_ref              text        NULL, -- opaque next-action reference from BC-04 (customer challenge)
    action_expires_at_utc   timestamptz NULL,
    expires_at_utc          timestamptz NULL,
    created_at_utc          timestamptz NOT NULL,
    updated_at_utc          timestamptz NOT NULL,
    CHECK (capture_method <> 'MANUAL' OR captured_minor + reserved_capture_minor <= authorized_minor),
    CHECK (captured_minor <= amount_requested_minor),
    CHECK (intent_status <> 'SUCCEEDED' OR captured_minor > 0),
    CHECK (intent_status NOT IN ('CANCELED','EXPIRED','FAILED') OR captured_minor = 0),
    CHECK (intent_status NOT IN ('SUCCEEDED','FAILED','CANCELED','EXPIRED') OR active_operation_id IS NULL),
    CHECK (intent_status <> 'REQUIRES_CONFIRMATION' OR payment_method_token_ref IS NOT NULL)
);
CREATE INDEX payment_intents_list ON payment.payment_intents (tenant_id, merchant_id, environment, public_id);
CREATE INDEX payment_intents_expiry ON payment.payment_intents (expires_at_utc)
    WHERE expires_at_utc IS NOT NULL AND intent_status IN ('REQUIRES_PAYMENT_METHOD','REQUIRES_CONFIRMATION','PROCESSING');

-- Invariants the reducer must never violate, enforced again in the database
-- (06-01 PI-INV-01, -08, -09, §5.3; PI-AT-011, -012, -057).
CREATE FUNCTION payment.zp_intent_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'payment intents are never deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.intent_id, NEW.public_id, NEW.environment, NEW.tenant_id, NEW.merchant_id, NEW.cell_id, NEW.legal_entity_id,
        NEW.amount_requested_minor, NEW.currency, NEW.currency_spec_version, NEW.capture_method, NEW.merchant_reference,
        NEW.created_at_utc)
       IS DISTINCT FROM
       (OLD.intent_id, OLD.public_id, OLD.environment, OLD.tenant_id, OLD.merchant_id, OLD.cell_id, OLD.legal_entity_id,
        OLD.amount_requested_minor, OLD.currency, OLD.currency_spec_version, OLD.capture_method, OLD.merchant_reference,
        OLD.created_at_utc) THEN
        RAISE EXCEPTION 'immutable payment intent field changed' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.aggregate_version <> OLD.aggregate_version + 1 THEN
        RAISE EXCEPTION 'aggregate_version must advance by exactly one' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.intent_status IN ('SUCCEEDED','FAILED','CANCELED','EXPIRED') AND NEW.intent_status <> OLD.intent_status THEN
        RAISE EXCEPTION 'terminal status % cannot change', OLD.intent_status USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.intent_status = 'SUCCEEDED' AND OLD.intent_status NOT IN ('SUCCEEDED','PROCESSING','REQUIRES_CAPTURE','PARTIALLY_CAPTURED') THEN
        RAISE EXCEPTION 'SUCCEEDED only from an executing state' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.captured_minor < OLD.captured_minor OR NEW.authorized_minor < OLD.authorized_minor THEN
        RAISE EXCEPTION 'captured and authorized amounts never decrease' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.frozen_at_utc IS NOT NULL AND NEW.frozen_at_utc IS NULL THEN
        RAISE EXCEPTION 'a frozen intent is unfrozen only by an approved recovery process' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER payment_intents_guard BEFORE UPDATE OR DELETE ON payment.payment_intents
    FOR EACH ROW EXECUTE FUNCTION payment.zp_intent_guard();
CREATE TRIGGER payment_intents_guard_truncate BEFORE TRUNCATE ON payment.payment_intents
    FOR EACH STATEMENT EXECUTE FUNCTION payment.zp_no_delete();

-- ---------------------------------------------------------------------------
-- payment_operations: one row per effectful command (06-01 §3.2, PI-INV-02/03).
CREATE TABLE payment.payment_operations (
    operation_id        uuid        PRIMARY KEY CHECK (uuid_extract_version(operation_id) = 7),
    public_id           text        NOT NULL UNIQUE
                                    CHECK (public_id ~ '^op_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$'),
    intent_id           uuid        NOT NULL REFERENCES payment.payment_intents (intent_id),
    tenant_id           text        NOT NULL,
    kind                text        NOT NULL CHECK (kind IN ('CONFIRM','CAPTURE','VOID')),
    economic_effect_id  uuid        NOT NULL UNIQUE CHECK (uuid_extract_version(economic_effect_id) = 7),
    requested_minor     bigint      NOT NULL CHECK (requested_minor >= 0),
    currency            text        NOT NULL CHECK (currency IN ('EUR', 'GBP', 'USD')),
    resolution          text        NOT NULL CHECK (resolution IN ('PENDING','UNKNOWN','CERTAIN_POSITIVE','CERTAIN_NEGATIVE','CONFLICTED')),
    policy_version      text        NOT NULL,
    created_at_utc      timestamptz NOT NULL,
    resolved_at_utc     timestamptz NULL,
    CHECK ((resolution IN ('CERTAIN_POSITIVE','CERTAIN_NEGATIVE')) = (resolved_at_utc IS NOT NULL) OR resolution = 'CONFLICTED')
);
-- PI-INV-03 / 06-01 §9.1: at most one unresolved effectful operation per intent.
CREATE UNIQUE INDEX payment_operations_one_active ON payment.payment_operations (intent_id)
    WHERE resolution IN ('PENDING','UNKNOWN','CONFLICTED');
CREATE INDEX payment_operations_unresolved_age ON payment.payment_operations (created_at_utc)
    WHERE resolution IN ('PENDING','UNKNOWN');
ALTER TABLE payment.payment_intents
    ADD CONSTRAINT payment_intents_active_operation_fk FOREIGN KEY (active_operation_id) REFERENCES payment.payment_operations (operation_id),
    ADD CONSTRAINT payment_intents_latest_operation_fk FOREIGN KEY (latest_operation_id) REFERENCES payment.payment_operations (operation_id);

CREATE FUNCTION payment.zp_operation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'payment operations are never deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.operation_id, NEW.public_id, NEW.intent_id, NEW.tenant_id, NEW.kind, NEW.economic_effect_id,
        NEW.requested_minor, NEW.currency, NEW.policy_version, NEW.created_at_utc)
       IS DISTINCT FROM
       (OLD.operation_id, OLD.public_id, OLD.intent_id, OLD.tenant_id, OLD.kind, OLD.economic_effect_id,
        OLD.requested_minor, OLD.currency, OLD.policy_version, OLD.created_at_utc) THEN
        RAISE EXCEPTION 'operation identity is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    -- A proven outcome can only be questioned (CONFLICTED), never rewritten.
    IF OLD.resolution IN ('CERTAIN_POSITIVE','CERTAIN_NEGATIVE') AND NEW.resolution NOT IN (OLD.resolution, 'CONFLICTED') THEN
        RAISE EXCEPTION 'resolved operation % cannot become %', OLD.resolution, NEW.resolution USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.resolution = 'CONFLICTED' AND NEW.resolution <> 'CONFLICTED' THEN
        RAISE EXCEPTION 'a conflicted operation is resolved only by an approved recovery process' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER payment_operations_guard BEFORE UPDATE OR DELETE ON payment.payment_operations
    FOR EACH ROW EXECUTE FUNCTION payment.zp_operation_guard();
CREATE TRIGGER payment_operations_guard_truncate BEFORE TRUNCATE ON payment.payment_operations
    FOR EACH STATEMENT EXECUTE FUNCTION payment.zp_no_delete();

-- ---------------------------------------------------------------------------
-- payment_attempts: stable provider instruction identity (06-01 §7.3 R0, PI-016).
CREATE TABLE payment.payment_attempts (
    attempt_id               uuid        PRIMARY KEY CHECK (uuid_extract_version(attempt_id) = 7),
    operation_id             uuid        NOT NULL UNIQUE REFERENCES payment.payment_operations (operation_id),
    tenant_id                text        NOT NULL,
    provider_instruction_key uuid        NOT NULL UNIQUE CHECK (uuid_extract_version(provider_instruction_key) = 7),
    provider_account_id      text        NULL,
    attempt_status           text        NOT NULL CHECK (attempt_status IN (
                                             'RESERVED','DISPATCHING','ACTION_REQUIRED','PENDING','AUTHORIZED',
                                             'SUCCEEDED','DECLINED','NO_EFFECT','UNKNOWN')),
    created_at_utc           timestamptz NOT NULL,
    updated_at_utc           timestamptz NOT NULL
);
CREATE UNIQUE INDEX payment_attempts_provider_instruction ON payment.payment_attempts (provider_account_id, provider_instruction_key)
    WHERE provider_account_id IS NOT NULL;

CREATE FUNCTION payment.zp_attempt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'payment attempts are never deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.attempt_id, NEW.operation_id, NEW.tenant_id, NEW.provider_instruction_key, NEW.created_at_utc)
       IS DISTINCT FROM (OLD.attempt_id, OLD.operation_id, OLD.tenant_id, OLD.provider_instruction_key, OLD.created_at_utc) THEN
        RAISE EXCEPTION 'attempt identity is immutable (never a fresh provider key)' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.provider_account_id IS NOT NULL AND NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id THEN
        RAISE EXCEPTION 'attempt provider account cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER payment_attempts_guard BEFORE UPDATE OR DELETE ON payment.payment_attempts
    FOR EACH ROW EXECUTE FUNCTION payment.zp_attempt_guard();
CREATE TRIGGER payment_attempts_guard_truncate BEFORE TRUNCATE ON payment.payment_attempts
    FOR EACH STATEMENT EXECUTE FUNCTION payment.zp_no_delete();

-- ---------------------------------------------------------------------------
-- provider_observations: every normalized observation received from BC-04,
-- with what the reducer did with it (06-01 §3.2, §7.2). Append-only.
CREATE TABLE payment.provider_observations (
    observation_id       uuid        PRIMARY KEY,
    tenant_id            text        NOT NULL,
    event_id             uuid        NOT NULL,
    operation_id         uuid        NULL REFERENCES payment.payment_operations (operation_id),
    operation_public_id  text        NOT NULL,
    outcome              text        NOT NULL,
    source_channel       text        NOT NULL CHECK (source_channel IN ('SYNC_RESPONSE','WEBHOOK','INQUIRY','DISPATCH')),
    provider_account_id  text        NULL,
    provider_reference   text        NULL,
    amount_minor         bigint      NULL,
    currency             text        NULL,
    evidence_digest      text        NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
    observed_at_utc      timestamptz NOT NULL,
    recorded_at_utc      timestamptz NOT NULL,
    disposition          text        NOT NULL CHECK (disposition IN ('APPLIED','RECORDED','DUPLICATE','IGNORED_TERMINAL','QUARANTINED','CONFLICT')),
    disposition_reason   text        NULL
);
CREATE INDEX provider_observations_operation ON payment.provider_observations (operation_id, recorded_at_utc);
CREATE TRIGGER provider_observations_append_only BEFORE UPDATE OR DELETE ON payment.provider_observations
    FOR EACH ROW EXECUTE FUNCTION payment.zp_append_only();
CREATE TRIGGER provider_observations_append_only_truncate BEFORE TRUNCATE ON payment.provider_observations
    FOR EACH STATEMENT EXECUTE FUNCTION payment.zp_append_only();

-- ---------------------------------------------------------------------------
-- intent_transitions: append-only transition audit (06-01 §3.2 TransitionAudit, PI-010).
CREATE TABLE payment.intent_transitions (
    transition_id      uuid        PRIMARY KEY CHECK (uuid_extract_version(transition_id) = 7),
    intent_id          uuid        NOT NULL REFERENCES payment.payment_intents (intent_id),
    tenant_id          text        NOT NULL,
    aggregate_version  bigint      NOT NULL,
    input              text        NOT NULL,
    from_status        text        NULL,
    to_status          text        NOT NULL,
    operation_id       uuid        NULL REFERENCES payment.payment_operations (operation_id),
    observation_id     uuid        NULL REFERENCES payment.provider_observations (observation_id),
    actor              text        NOT NULL,
    policy_version     text        NULL,
    reason_code        text        NULL,
    correlation_id     text        NOT NULL,
    recorded_at_utc    timestamptz NOT NULL,
    UNIQUE (intent_id, aggregate_version)
);
CREATE TRIGGER intent_transitions_append_only BEFORE UPDATE OR DELETE ON payment.intent_transitions
    FOR EACH ROW EXECUTE FUNCTION payment.zp_append_only();
CREATE TRIGGER intent_transitions_append_only_truncate BEFORE TRUNCATE ON payment.intent_transitions
    FOR EACH STATEMENT EXECUTE FUNCTION payment.zp_append_only();

-- ---------------------------------------------------------------------------
-- command_log: every payment command and its outcome, including refused ones.
CREATE TABLE payment.command_log (
    command_log_id     uuid        PRIMARY KEY CHECK (uuid_extract_version(command_log_id) = 7),
    tenant_id          text        NOT NULL,
    merchant_id        text        NOT NULL,
    command            text        NOT NULL,
    intent_public_id   text        NULL,
    operation_public_id text       NULL,
    outcome            text        NOT NULL CHECK (outcome IN ('ACCEPTED','REPLAYED','REFUSED')),
    problem_code       text        NULL,
    actor              text        NOT NULL,
    request_id         text        NOT NULL,
    recorded_at_utc    timestamptz NOT NULL
);
CREATE TRIGGER command_log_append_only BEFORE UPDATE OR DELETE ON payment.command_log
    FOR EACH ROW EXECUTE FUNCTION payment.zp_append_only();
CREATE TRIGGER command_log_append_only_truncate BEFORE TRUNCATE ON payment.command_log
    FOR EACH STATEMENT EXECUTE FUNCTION payment.zp_append_only();

-- ---------------------------------------------------------------------------
-- recovery_cases: operational cases for unresolved or conflicting effects
-- (06-01 §7.3 R5, PI-022, PI-046; 04-08 §7 recovery_cases).
CREATE TABLE payment.recovery_cases (
    case_id          uuid        PRIMARY KEY CHECK (uuid_extract_version(case_id) = 7),
    tenant_id        text        NOT NULL,
    intent_id        uuid        NOT NULL REFERENCES payment.payment_intents (intent_id),
    operation_id     uuid        NULL REFERENCES payment.payment_operations (operation_id),
    reason           text        NOT NULL CHECK (reason IN ('UNRESOLVED_OPERATION','CONFLICTING_EVIDENCE','QUARANTINED_OBSERVATION','EXPIRED_WITH_UNRESOLVED_EFFECT')),
    status           text        NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
    detail           text        NOT NULL,
    opened_at_utc    timestamptz NOT NULL,
    resolved_at_utc  timestamptz NULL,
    resolved_by      text        NULL
);
CREATE UNIQUE INDEX recovery_cases_one_open ON payment.recovery_cases (intent_id, coalesce(operation_id, '00000000-0000-7000-8000-000000000000'::uuid), reason)
    WHERE status = 'OPEN';
CREATE TRIGGER recovery_cases_no_delete BEFORE DELETE ON payment.recovery_cases
    FOR EACH ROW EXECUTE FUNCTION payment.zp_no_delete();
CREATE TRIGGER recovery_cases_no_delete_truncate BEFORE TRUNCATE ON payment.recovery_cases
    FOR EACH STATEMENT EXECUTE FUNCTION payment.zp_no_delete();

-- ---------------------------------------------------------------------------
-- work_schedule: identifiers only (no amounts, no references, no PII), so
-- background sweepers can find due work across tenants and then act inside
-- each tenant's own RLS transaction (ADR 0006 §6). Not tenant-isolated by
-- design; holds nothing a tenant could learn from.
CREATE TABLE payment.work_schedule (
    kind           text        NOT NULL CHECK (kind IN ('OPERATION_RESOLUTION','INTENT_EXPIRY')),
    ref_id         uuid        NOT NULL,
    environment    text        NOT NULL CHECK (environment IN ('TEST','LIVE')),
    tenant_id      text        NOT NULL,
    cell_id        text        NOT NULL,
    legal_entity_id text       NOT NULL,
    due_at_utc     timestamptz NOT NULL,
    done_at_utc    timestamptz NULL,
    PRIMARY KEY (kind, ref_id)
);
CREATE INDEX work_schedule_due ON payment.work_schedule (kind, due_at_utc) WHERE done_at_utc IS NULL;
CREATE TRIGGER work_schedule_no_delete BEFORE DELETE ON payment.work_schedule
    FOR EACH ROW EXECUTE FUNCTION payment.zp_no_delete();
CREATE TRIGGER work_schedule_no_delete_truncate BEFORE TRUNCATE ON payment.work_schedule
    FOR EACH STATEMENT EXECUTE FUNCTION payment.zp_no_delete();
GRANT SELECT, INSERT ON payment.work_schedule TO zp_execution;
GRANT UPDATE (done_at_utc) ON payment.work_schedule TO zp_execution;

-- ---------------------------------------------------------------------------
-- Tenant isolation (ADR 0005 §6): forced RLS on every table.
ALTER TABLE payment.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment.payment_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.payment_intents
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));
ALTER TABLE payment.payment_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment.payment_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.payment_operations
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));
ALTER TABLE payment.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment.payment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.payment_attempts
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));
ALTER TABLE payment.provider_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment.provider_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.provider_observations
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));
ALTER TABLE payment.intent_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment.intent_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.intent_transitions
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));
ALTER TABLE payment.command_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment.command_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.command_log
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));
ALTER TABLE payment.recovery_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment.recovery_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.recovery_cases
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));

-- ---------------------------------------------------------------------------
-- Least privilege for zp_execution: read and insert; update only the columns
-- the reducer changes; no DELETE anywhere.
GRANT SELECT, INSERT ON payment.payment_intents, payment.payment_operations, payment.payment_attempts,
    payment.provider_observations, payment.intent_transitions, payment.command_log, payment.recovery_cases TO zp_execution;
GRANT UPDATE (payment_method_token_ref, intent_status, status_reason_code, aggregate_version, active_operation_id,
    latest_operation_id, authorized_minor, captured_minor, reserved_capture_minor, policy_version,
    cancel_requested_at_utc, expiry_flagged_at_utc, frozen_at_utc, action_ref, action_expires_at_utc, updated_at_utc)
    ON payment.payment_intents TO zp_execution;
GRANT UPDATE (resolution, resolved_at_utc) ON payment.payment_operations TO zp_execution;
GRANT UPDATE (provider_account_id, attempt_status, updated_at_utc) ON payment.payment_attempts TO zp_execution;
-- Cases are resolved by an approved recovery process (not this module's runtime role).
-- +goose StatementEnd
