-- +goose Up
-- BC-01 tenant memberships: who may act for a tenant, as which merchant
-- persona, in which environment (02-02 §2.2 "Canonical tenant registry and
-- delegated mandate"; §3 TENANT.ROLE.GRANT / TENANT.ROLE.REVOKE).
-- Writer: zp_gateway (deployable D1).
--
-- Authority comes from these rows, never from the identity token: 02-02 §2.2
-- "Do not accept client-supplied tenant as proof of membership"; 03-05 "not
-- ... unverified JWT custom claims". A member is identified by the verified
-- (issuer, subject) pair, so the table works with any OIDC issuer.
--
-- Scope of this table: the five merchant personas only. Platform staff
-- (POR, PFIN, PIAM, SUPER_ADMIN, …) are not tenant members; their grants
-- need a separate design (OPEN_QUESTIONS Q36). Invitations (TENANT.USERS.INVITE)
-- and pending maker-checker requests are not stored here: a row is an
-- approved, effective grant with its evidence.
-- +goose StatementBegin

-- A membership may name one merchant; it must be that tenant's merchant, in
-- the same environment. merchant_id is already unique; this key exists for
-- the composite foreign key below.
ALTER TABLE merchant.merchants
    ADD CONSTRAINT merchants_tenant_merchant_environment UNIQUE (tenant_id, merchant_id, environment);

CREATE TABLE merchant.memberships (
    id                  uuid        PRIMARY KEY CHECK (uuid_extract_version(id) = 7),
    -- The member: the verified token's iss and sub.
    issuer              text        NOT NULL CHECK (issuer ~ '^https?://[^[:space:]]+$' AND length(issuer) <= 512),
    subject             text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 255 AND subject !~ '[[:space:]]'),
    tenant_id           text        NOT NULL REFERENCES merchant.tenants (tenant_id),
    merchant_id         text        NULL, -- NULL: every merchant of the tenant in this environment
    environment         text        NOT NULL CHECK (environment IN ('TEST','LIVE')), -- 02-02 §2.4: distinct principals per environment
    persona             text        NOT NULL CHECK (persona IN ('MOWN','MOPS','MFIN','MDEV','MVIEW')),
    -- Evidence of the grant: maker and independent checker (02-02 §3
    -- TENANT.ROLE.GRANT: "never the same human or workload identity").
    granted_by_issuer   text        NOT NULL,
    granted_by_subject  text        NOT NULL,
    approved_by_issuer  text        NOT NULL,
    approved_by_subject text        NOT NULL,
    granted_at_utc      timestamptz NOT NULL,
    -- Revocation: set once, never cleared (02-02 §3 TENANT.ROLE.REVOKE "immediate effective deny").
    revoked_by_issuer   text        NULL,
    revoked_by_subject  text        NULL,
    revoked_at_utc      timestamptz NULL,
    FOREIGN KEY (tenant_id, merchant_id, environment)
        REFERENCES merchant.merchants (tenant_id, merchant_id, environment),
    CONSTRAINT evidence_present CHECK (
        granted_by_issuer <> '' AND granted_by_subject <> '' AND approved_by_issuer <> '' AND approved_by_subject <> ''
        AND coalesce(revoked_by_issuer, '-') <> '' AND coalesce(revoked_by_subject, '-') <> ''),
    CONSTRAINT checker_is_independent CHECK ((approved_by_issuer, approved_by_subject) <> (granted_by_issuer, granted_by_subject)),
    CONSTRAINT no_self_grant CHECK ((granted_by_issuer, granted_by_subject) <> (issuer, subject)),
    CONSTRAINT no_self_approval CHECK ((approved_by_issuer, approved_by_subject) <> (issuer, subject)),
    CONSTRAINT revocation_complete CHECK (
        (revoked_at_utc IS NULL AND revoked_by_issuer IS NULL AND revoked_by_subject IS NULL)
        OR (revoked_at_utc IS NOT NULL AND revoked_by_issuer IS NOT NULL AND revoked_by_subject IS NOT NULL)),
    CONSTRAINT revoked_after_granted CHECK (revoked_at_utc >= granted_at_utc)
);

-- One active grant per member, tenant, merchant scope, environment and persona.
-- NULLS NOT DISTINCT makes two tenant-wide (NULL merchant) grants collide too.
CREATE UNIQUE INDEX memberships_one_active ON merchant.memberships
    (issuer, subject, tenant_id, merchant_id, environment, persona) NULLS NOT DISTINCT
    WHERE revoked_at_utc IS NULL;
CREATE INDEX memberships_by_subject ON merchant.memberships (issuer, subject) WHERE revoked_at_utc IS NULL;
CREATE INDEX memberships_by_tenant ON merchant.memberships (tenant_id, environment);

-- Everything about a grant is fixed once written; the only change allowed is
-- one revocation. Rows are never deleted, so the grant history stays complete.
CREATE FUNCTION merchant.zp_membership_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'memberships are never deleted; revoke them instead' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.id, NEW.issuer, NEW.subject, NEW.tenant_id, NEW.merchant_id, NEW.environment, NEW.persona,
        NEW.granted_by_issuer, NEW.granted_by_subject, NEW.approved_by_issuer, NEW.approved_by_subject, NEW.granted_at_utc)
       IS DISTINCT FROM
       (OLD.id, OLD.issuer, OLD.subject, OLD.tenant_id, OLD.merchant_id, OLD.environment, OLD.persona,
        OLD.granted_by_issuer, OLD.granted_by_subject, OLD.approved_by_issuer, OLD.approved_by_subject, OLD.granted_at_utc) THEN
        RAISE EXCEPTION 'a membership grant cannot change; revoke it and grant a new one' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.revoked_at_utc IS NOT NULL AND (NEW.revoked_at_utc, NEW.revoked_by_issuer, NEW.revoked_by_subject)
       IS DISTINCT FROM (OLD.revoked_at_utc, OLD.revoked_by_issuer, OLD.revoked_by_subject) THEN
        RAISE EXCEPTION 'a revocation is final' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER membership_guard BEFORE UPDATE OR DELETE ON merchant.memberships
    FOR EACH ROW EXECUTE FUNCTION merchant.zp_membership_guard();
CREATE TRIGGER membership_guard_truncate BEFORE TRUNCATE ON merchant.memberships
    FOR EACH STATEMENT EXECUTE FUNCTION merchant.zp_no_delete();

-- ---------------------------------------------------------------------------
-- Row-level security, forced. Two permissive policies:
--   tenant_isolation (all commands): rows of the transaction's zp.tenant_id.
--   own_active_memberships (SELECT only): the caller's own active grants, by
--     the verified (zp.subject_issuer, zp.subject), so the server can resolve
--     which tenants a caller belongs to before a tenant is chosen.
-- Writes and revocations always need the tenant context; the subject policy
-- never reveals another member, a revoked grant or another issuer's subject.
ALTER TABLE merchant.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merchant.memberships
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));
CREATE POLICY own_active_memberships ON merchant.memberships FOR SELECT
    USING (revoked_at_utc IS NULL
           AND issuer = current_setting('zp.subject_issuer', true)
           AND subject = current_setting('zp.subject', true));

-- Least privilege for zp_gateway: read, grant and revoke; nothing else.
GRANT SELECT, INSERT ON merchant.memberships TO zp_gateway;
GRANT UPDATE (revoked_at_utc, revoked_by_issuer, revoked_by_subject) ON merchant.memberships TO zp_gateway;
-- +goose StatementEnd
