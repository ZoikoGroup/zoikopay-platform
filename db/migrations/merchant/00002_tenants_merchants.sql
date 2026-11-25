-- +goose Up
-- BC-01 Merchant and Tenant: the tenant registry and merchant profiles
-- (01-03 "tenant", 03-04 §5, 04-03 §4 and §6; ADR 0005 §6).
-- Writer: zp_gateway (deployable D1). Both tables are tenant-isolated with
-- forced row-level security (03-04 CELL-002: a cross-tenant query yields no
-- rows). Identity columns are immutable; rows are never deleted, by any role,
-- including the owner.
--
-- Deliberately not here yet: tenant lifecycle states (no spec defines them,
-- OPEN_QUESTIONS Q35), merchant legal entities, onboarding cases, capabilities
-- and API clients (04-03; separate resources, later migrations).
-- +goose StatementBegin

CREATE FUNCTION merchant.zp_no_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------------------
-- tenants: logical customer organizations (01-03). tenant_id is the public,
-- server-generated ID (04-03 §2 "opaque immutable server-generated
-- identifiers"; prefix ten_, ADR 0001 §6, Q15). It is also the value of
-- zp.tenant_id that row-level security compares against.
CREATE TABLE merchant.tenants (
    id             uuid        PRIMARY KEY CHECK (uuid_extract_version(id) = 7),
    tenant_id      text        NOT NULL UNIQUE
                               CHECK (tenant_id ~ '^ten_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$'),
    display_name   text        NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
    created_at_utc timestamptz NOT NULL,
    updated_at_utc timestamptz NOT NULL,
    CHECK (updated_at_utc >= created_at_utc)
);

CREATE FUNCTION merchant.zp_tenant_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'tenants are never deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.created_at_utc) IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.created_at_utc) THEN
        RAISE EXCEPTION 'a tenant''s identity cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.updated_at_utc < OLD.updated_at_utc THEN
        RAISE EXCEPTION 'updated_at_utc cannot move backwards' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER tenant_guard BEFORE UPDATE OR DELETE ON merchant.tenants
    FOR EACH ROW EXECUTE FUNCTION merchant.zp_tenant_guard();
CREATE TRIGGER tenant_guard_truncate BEFORE TRUNCATE ON merchant.tenants
    FOR EACH STATEMENT EXECUTE FUNCTION merchant.zp_no_delete();

-- ---------------------------------------------------------------------------
-- merchants: merchant profiles owned by BC-01 (04-03 §6.1). Canonical binding
-- tenant_id → merchant_id (03-04 §5). status is the registration and review
-- lifecycle only (04-03 §4 proposed states, upper case in the database per
-- ADR 0001 §2); it never proves payment eligibility, which is BC-02's
-- capability decision. revision is the monotonic resource version (04-03 §6,
-- If-Match); it increases by exactly one per update.
CREATE TABLE merchant.merchants (
    id             uuid        PRIMARY KEY CHECK (uuid_extract_version(id) = 7),
    merchant_id    text        NOT NULL UNIQUE
                               CHECK (merchant_id ~ '^mer_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$'),
    tenant_id      text        NOT NULL REFERENCES merchant.tenants (tenant_id),
    environment    text        NOT NULL CHECK (environment IN ('TEST','LIVE')),
    display_name   text        NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
    status         text        NOT NULL CHECK (status IN (
                                   'DRAFT','SUBMITTED','UNDER_REVIEW','NEEDS_INFORMATION',
                                   'VERIFIED','REJECTED','SUSPENDED','CLOSED')),
    revision       bigint      NOT NULL CHECK (revision > 0),
    created_at_utc timestamptz NOT NULL,
    updated_at_utc timestamptz NOT NULL,
    CHECK (updated_at_utc >= created_at_utc)
);
CREATE INDEX merchants_by_tenant ON merchant.merchants (tenant_id, environment, merchant_id);

CREATE FUNCTION merchant.zp_merchant_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'merchants are never deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    -- 04-03 MER-INV-24 and §2: ownership, environment and identity are fixed at creation.
    IF (NEW.id, NEW.merchant_id, NEW.tenant_id, NEW.environment, NEW.created_at_utc)
       IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.tenant_id, OLD.environment, OLD.created_at_utc) THEN
        RAISE EXCEPTION 'a merchant''s identity, tenant and environment cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'merchant revision must increase by exactly one' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.updated_at_utc < OLD.updated_at_utc THEN
        RAISE EXCEPTION 'updated_at_utc cannot move backwards' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER merchant_guard BEFORE UPDATE OR DELETE ON merchant.merchants
    FOR EACH ROW EXECUTE FUNCTION merchant.zp_merchant_guard();
CREATE TRIGGER merchant_guard_truncate BEFORE TRUNCATE ON merchant.merchants
    FOR EACH STATEMENT EXECUTE FUNCTION merchant.zp_no_delete();

-- ---------------------------------------------------------------------------
-- Tenant isolation (ADR 0005 §6): forced RLS. With no zp.tenant_id set,
-- nothing is visible and nothing can be written (fails closed).
ALTER TABLE merchant.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merchant.tenants
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));
ALTER TABLE merchant.merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant.merchants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merchant.merchants
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));

-- ---------------------------------------------------------------------------
-- Least privilege for zp_gateway: read and insert; update only the mutable
-- columns; no DELETE. Identity, tenant and environment columns have no
-- UPDATE grant, and the guards above refuse them for every role.
GRANT SELECT, INSERT ON merchant.tenants, merchant.merchants TO zp_gateway;
GRANT UPDATE (display_name, updated_at_utc) ON merchant.tenants TO zp_gateway;
GRANT UPDATE (display_name, status, revision, updated_at_utc) ON merchant.merchants TO zp_gateway;
-- +goose StatementEnd
