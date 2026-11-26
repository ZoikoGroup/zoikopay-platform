-- +goose Up
-- BC-08 business audit log (OPEN_QUESTIONS Q38; 03-05 §14; 02-02 §6.4).
-- Written only by role zp_audit (INSERT, SELECT); no business role has any
-- access. Append-only for every role, including the owner and superusers.
-- No free-text column: every value is an ID, code, hash or URL with a strict
-- format, so tokens, passwords and secrets have nowhere to go (38.8).
-- +goose StatementBegin

CREATE TABLE governance.audit_events (
    id              uuid        PRIMARY KEY CHECK (uuid_extract_version(id) = 7),
    occurred_at_utc timestamptz NOT NULL,      -- set by the database clock (38.6)
    trace_id        text        NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
    -- Who: the verified identity only (38.9); both or neither.
    actor_issuer    text        NULL CHECK (actor_issuer ~ '^https?://[^[:space:]]+$' AND length(actor_issuer) <= 512
                                            AND actor_issuer !~ 'eyJ'),
    actor_subject   text        NULL CHECK (length(actor_subject) BETWEEN 1 AND 255 AND actor_subject !~ '[[:space:]]'
                                            AND actor_subject !~ '^eyJ'),
    environment     text        NOT NULL CHECK (environment IN ('TEST','LIVE')),
    tenant_id       text        NULL CHECK (tenant_id ~ '^ten_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$'),
    action          text        NOT NULL CHECK (action ~ '^[A-Za-z][A-Za-z0-9_.]{0,63}$' AND action !~ '^eyJ'),
    resource_type   text        NULL CHECK (resource_type ~ '^[a-z][a-z_]{0,31}$'),
    resource_hash   text        NULL CHECK (resource_hash ~ '^[0-9a-f]{64}$'), -- SHA-256, never the raw ID (38.7)
    outcome         text        NOT NULL CHECK (outcome IN ('ALLOWED','DENIED','FAILED')),
    http_status     integer     NOT NULL CHECK (http_status BETWEEN 100 AND 599),
    reason          text        NULL CHECK (reason ~ '^[a-z][a-z_]{0,63}$'),
    CONSTRAINT actor_complete CHECK ((actor_issuer IS NULL) = (actor_subject IS NULL)),
    CONSTRAINT resource_complete CHECK ((resource_type IS NULL) = (resource_hash IS NULL)),
    CONSTRAINT outcome_matches_status CHECK (
        (outcome = 'ALLOWED' AND http_status < 400)
        OR (outcome = 'DENIED' AND http_status BETWEEN 400 AND 499)
        OR (outcome = 'FAILED' AND http_status >= 500))
);
CREATE INDEX audit_events_by_tenant ON governance.audit_events (tenant_id, environment, occurred_at_utc) WHERE tenant_id IS NOT NULL;
CREATE INDEX audit_events_by_trace ON governance.audit_events (trace_id);

-- The database, not the application, assigns the ID and the time (03-05 §14
-- "trusted UTC clocks"): whatever a writer supplies is replaced.
CREATE FUNCTION governance.zp_audit_stamp() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    NEW.id := uuidv7();
    NEW.occurred_at_utc := clock_timestamp();
    RETURN NEW;
END $$;
CREATE TRIGGER audit_events_stamp BEFORE INSERT ON governance.audit_events
    FOR EACH ROW EXECUTE FUNCTION governance.zp_audit_stamp();

-- Append-only (38.4): UPDATE, DELETE and TRUNCATE are refused for every role,
-- the owner and superusers included.
CREATE FUNCTION governance.zp_audit_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'the audit log is append-only' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON governance.audit_events
    FOR EACH ROW EXECUTE FUNCTION governance.zp_audit_append_only();
CREATE TRIGGER audit_events_append_only_truncate BEFORE TRUNCATE ON governance.audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION governance.zp_audit_append_only();

-- Tenant isolation (38.11), forced so the owner obeys it too:
--   read:  only the transaction's tenant; entries without a tenant (401, 404,
--          outages) are readable by no runtime role yet.
--   write: an entry without a tenant, or one for the transaction's tenant.
ALTER TABLE governance.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON governance.audit_events FOR SELECT TO zp_audit
    USING (tenant_id = current_setting('zp.tenant_id', true));
CREATE POLICY record ON governance.audit_events FOR INSERT TO zp_audit
    WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('zp.tenant_id', true));

-- Role separation (38.2): zp_audit may INSERT and SELECT this table and
-- nothing else; no other runtime role gets any grant on it.
GRANT USAGE ON SCHEMA governance TO zp_audit;
GRANT SELECT, INSERT ON governance.audit_events TO zp_audit;
-- +goose StatementEnd
