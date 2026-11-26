-- +goose Up
-- BC-01 grant administration (02-02 WF-002, TENANT.USERS.INVITE,
-- TENANT.ROLE.GRANT, TENANT.ROLE.REVOKE, JRN-03; 03-05 §9.2, §13.1, §14;
-- OPEN_QUESTIONS Q36 36.10–36.15 and Q40). Writer: zp_gateway (deployable D1).
--
-- Who may do what is enforced here, not only in the application (36.15):
--   * invitations: issued by an owner (MOWN) of the tenant; stored as a token
--     hash only; single use; expiring; never accepted by the inviter.
--   * access requests: made by an owner whose own grant covers the requested
--     scope and outlasts it; for a person who accepted an invitation or holds
--     a live grant in the tenant; decided once by an owner who covers it;
--     maker ≠ checker ≠ member.
--   * grants: the runtime role creates a grant only from an approved request
--     that matches it exactly, never an owner grant, and only while maker and
--     checker still hold covering owner grants that outlast it ("never grant
--     above the delegator"). It revokes only non-owner grants, and only as an
--     owner covering them.
-- These rules bind every role except the provisioning role, which today is
-- only the database superuser: owner grants and the first owner of a tenant
-- come from governed tenant provisioning (03-05 §2.1; 05-03 missing; 36.14).
-- Every change leaves an append-only grant event written by triggers, so no
-- grant changes without its evidence and the runtime role cannot forge one.
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- Helpers.

-- The provisioning role: today the database superuser only (Q40).
CREATE FUNCTION merchant.zp_is_provisioning() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
    SELECT coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false)
$$;

-- Whether (issuer, subject) holds a live owner (MOWN) grant in tenant and
-- environment that covers merchant (NULL: the whole tenant, which only a
-- tenant-wide owner grant covers) and lasts at least until "until" (NULL: any).
-- Runs as the caller, so the caller's row-level security applies.
CREATE FUNCTION merchant.zp_owner_covers(p_tenant text, p_environment text, p_issuer text, p_subject text,
                                         p_merchant text, p_until timestamptz)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
    SELECT EXISTS (
        SELECT 1 FROM merchant.memberships o
        WHERE o.tenant_id = p_tenant AND o.environment = p_environment
          AND o.issuer = p_issuer AND o.subject = p_subject AND o.persona = 'MOWN'
          AND o.revoked_at_utc IS NULL AND o.effective_from_utc <= now() AND o.expires_at_utc > now()
          AND (p_until IS NULL OR o.expires_at_utc >= p_until)
          AND (o.merchant_id IS NULL OR o.merchant_id = p_merchant))
$$;

-- Append-only: refuses every UPDATE, DELETE and TRUNCATE, for every role.
CREATE FUNCTION merchant.zp_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------------------
-- Public grant IDs (mbr_). Existing grants get one each (local and test
-- databases only: no shared environment has applied these migrations).
ALTER TABLE merchant.memberships
    ADD COLUMN membership_id text NOT NULL DEFAULT ('mbr_' || replace(uuidv7()::text, '-', ''))
        CONSTRAINT membership_id_format CHECK (membership_id ~ '^mbr_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$'),
    ADD CONSTRAINT memberships_membership_id_key UNIQUE (membership_id);

-- ---------------------------------------------------------------------------
-- Invitations (36.10): single use, expiring, tenant-scoped; grant nothing.
CREATE TABLE merchant.invitations (
    id                  uuid        PRIMARY KEY DEFAULT uuidv7() CHECK (uuid_extract_version(id) = 7),
    invitation_id       text        NOT NULL UNIQUE
                                    CHECK (invitation_id ~ '^inv_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$'),
    tenant_id           text        NOT NULL REFERENCES merchant.tenants (tenant_id),
    environment         text        NOT NULL CHECK (environment IN ('TEST','LIVE')),
    -- SHA-256 of the one-time token; the token itself is never stored.
    token_hash          bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    invited_by_issuer   text        NOT NULL CHECK (invited_by_issuer ~ '^https?://[^[:space:]]+$' AND length(invited_by_issuer) <= 512),
    invited_by_subject  text        NOT NULL CHECK (length(invited_by_subject) BETWEEN 1 AND 255 AND invited_by_subject !~ '[[:space:]]'),
    created_at_utc      timestamptz NOT NULL DEFAULT now(),
    expires_at_utc      timestamptz NOT NULL,
    accepted_by_issuer  text        NULL CHECK (accepted_by_issuer ~ '^https?://[^[:space:]]+$' AND length(accepted_by_issuer) <= 512),
    accepted_by_subject text        NULL CHECK (length(accepted_by_subject) BETWEEN 1 AND 255 AND accepted_by_subject !~ '[[:space:]]'),
    accepted_at_utc     timestamptz NULL,
    CONSTRAINT invitation_window CHECK (expires_at_utc > created_at_utc),
    CONSTRAINT acceptance_complete CHECK (
        (accepted_at_utc IS NULL) = (accepted_by_issuer IS NULL) AND (accepted_at_utc IS NULL) = (accepted_by_subject IS NULL)),
    CONSTRAINT inviter_cannot_accept CHECK ((accepted_by_issuer, accepted_by_subject) <> (invited_by_issuer, invited_by_subject))
);
CREATE INDEX invitations_by_tenant ON merchant.invitations (tenant_id, environment, created_at_utc DESC);

CREATE FUNCTION merchant.zp_invitation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'invitations are never deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.created_at_utc := now(); -- the database's clock, not the caller's
        IF NEW.accepted_at_utc IS NOT NULL OR NEW.accepted_by_subject IS NOT NULL THEN
            RAISE EXCEPTION 'an invitation is created unaccepted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NOT merchant.zp_is_provisioning() AND NOT EXISTS (
            SELECT 1 FROM merchant.memberships o
            WHERE o.tenant_id = NEW.tenant_id AND o.environment = NEW.environment
              AND o.issuer = NEW.invited_by_issuer AND o.subject = NEW.invited_by_subject AND o.persona = 'MOWN'
              AND o.revoked_at_utc IS NULL AND o.effective_from_utc <= now() AND o.expires_at_utc > now()) THEN
            RAISE EXCEPTION 'only an owner of the tenant can invite (TENANT.USERS.INVITE)' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;
    -- UPDATE: the only change is one acceptance, before expiry.
    IF (NEW.id, NEW.invitation_id, NEW.tenant_id, NEW.environment, NEW.token_hash, NEW.invited_by_issuer,
        NEW.invited_by_subject, NEW.created_at_utc, NEW.expires_at_utc)
       IS DISTINCT FROM
       (OLD.id, OLD.invitation_id, OLD.tenant_id, OLD.environment, OLD.token_hash, OLD.invited_by_issuer,
        OLD.invited_by_subject, OLD.created_at_utc, OLD.expires_at_utc) THEN
        RAISE EXCEPTION 'an invitation cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.accepted_at_utc IS NOT NULL THEN
        RAISE EXCEPTION 'an invitation is used only once' USING ERRCODE = 'restrict_violation';
    END IF;
    IF now() >= OLD.expires_at_utc THEN
        RAISE EXCEPTION 'the invitation has expired' USING ERRCODE = 'restrict_violation';
    END IF;
    NEW.accepted_at_utc := now();
    RETURN NEW;
END $$;
CREATE TRIGGER invitation_guard BEFORE INSERT OR UPDATE OR DELETE ON merchant.invitations
    FOR EACH ROW EXECUTE FUNCTION merchant.zp_invitation_guard();
CREATE TRIGGER invitation_guard_truncate BEFORE TRUNCATE ON merchant.invitations
    FOR EACH STATEMENT EXECUTE FUNCTION merchant.zp_no_delete();

-- ---------------------------------------------------------------------------
-- Access requests (03-05 §9.2 states; 02-02 §6.1 approval_request). EXPIRED is
-- not stored: a request still awaiting approval after decision_due_at_utc is
-- reported as expired and can no longer be decided.
CREATE TABLE merchant.access_requests (
    id                   uuid        PRIMARY KEY DEFAULT uuidv7() CHECK (uuid_extract_version(id) = 7),
    access_request_id    text        NOT NULL UNIQUE
                                     CHECK (access_request_id ~ '^acr_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$'),
    tenant_id            text        NOT NULL REFERENCES merchant.tenants (tenant_id),
    environment          text        NOT NULL CHECK (environment IN ('TEST','LIVE')),
    member_issuer        text        NOT NULL CHECK (member_issuer ~ '^https?://[^[:space:]]+$' AND length(member_issuer) <= 512),
    member_subject       text        NOT NULL CHECK (length(member_subject) BETWEEN 1 AND 255 AND member_subject !~ '[[:space:]]'),
    merchant_id          text        NULL, -- NULL: every merchant of the tenant in this environment
    -- Owner (MOWN) grants are not requested here (Q40).
    persona              text        NOT NULL CHECK (persona IN ('MOPS','MFIN','MDEV','MVIEW')),
    effective_from_utc   timestamptz NOT NULL,
    expires_at_utc       timestamptz NOT NULL,
    purpose              text        NOT NULL CHECK (length(btrim(purpose)) BETWEEN 1 AND 200 AND purpose !~ 'eyJ'),
    requested_by_issuer  text        NOT NULL,
    requested_by_subject text        NOT NULL,
    requested_at_utc     timestamptz NOT NULL DEFAULT now(),
    decision_due_at_utc  timestamptz NOT NULL,
    status               text        NOT NULL DEFAULT 'AWAITING_INDEPENDENT_APPROVAL'
                                     CHECK (status IN ('AWAITING_INDEPENDENT_APPROVAL','APPROVED','REJECTED')),
    decided_by_issuer    text        NULL,
    decided_by_subject   text        NULL,
    decided_at_utc       timestamptz NULL,
    decision_reason      text        NULL CHECK (length(btrim(decision_reason)) BETWEEN 1 AND 200 AND decision_reason !~ 'eyJ'),
    version              bigint      NOT NULL DEFAULT 1 CHECK (version > 0),
    FOREIGN KEY (tenant_id, merchant_id, environment) REFERENCES merchant.merchants (tenant_id, merchant_id, environment),
    CONSTRAINT request_window CHECK (expires_at_utc > effective_from_utc),
    CONSTRAINT decision_window CHECK (decision_due_at_utc > requested_at_utc),
    -- Three different people: maker, checker and member (02-02 TENANT.ROLE.GRANT; AT-012, AT-018).
    CONSTRAINT maker_is_not_member CHECK ((requested_by_issuer, requested_by_subject) <> (member_issuer, member_subject)),
    CONSTRAINT decider_is_not_member CHECK ((decided_by_issuer, decided_by_subject) <> (member_issuer, member_subject)),
    CONSTRAINT approver_is_not_maker CHECK (
        status <> 'APPROVED' OR (decided_by_issuer, decided_by_subject) <> (requested_by_issuer, requested_by_subject)),
    CONSTRAINT decision_complete CHECK (
        (status = 'AWAITING_INDEPENDENT_APPROVAL' AND decided_by_issuer IS NULL AND decided_by_subject IS NULL
            AND decided_at_utc IS NULL AND decision_reason IS NULL)
        OR (status = 'APPROVED' AND decided_by_issuer IS NOT NULL AND decided_by_subject IS NOT NULL AND decided_at_utc IS NOT NULL)
        OR (status = 'REJECTED' AND decided_by_issuer IS NOT NULL AND decided_by_subject IS NOT NULL AND decided_at_utc IS NOT NULL
            AND decision_reason IS NOT NULL))
);
CREATE INDEX access_requests_by_tenant ON merchant.access_requests (tenant_id, environment, requested_at_utc DESC);

CREATE FUNCTION merchant.zp_access_request_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'access requests are never deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.requested_at_utc := now();
        IF NEW.status <> 'AWAITING_INDEPENDENT_APPROVAL' OR NEW.version <> 1 THEN
            RAISE EXCEPTION 'a request starts awaiting independent approval at version 1' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NOT merchant.zp_is_provisioning() THEN
            -- Never above the delegator: the maker's own owner grant covers the scope and outlasts the request.
            IF NOT merchant.zp_owner_covers(NEW.tenant_id, NEW.environment, NEW.requested_by_issuer, NEW.requested_by_subject,
                                            NEW.merchant_id, NEW.expires_at_utc) THEN
                RAISE EXCEPTION 'the maker''s owner grant does not cover this request (never grant above the delegator)'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            -- The member is known to the tenant: an accepted invitation or a live grant here.
            IF NOT EXISTS (SELECT 1 FROM merchant.invitations i
                           WHERE i.tenant_id = NEW.tenant_id AND i.environment = NEW.environment
                             AND i.accepted_by_issuer = NEW.member_issuer AND i.accepted_by_subject = NEW.member_subject)
               AND NOT EXISTS (SELECT 1 FROM merchant.memberships m
                               WHERE m.tenant_id = NEW.tenant_id AND m.environment = NEW.environment
                                 AND m.issuer = NEW.member_issuer AND m.subject = NEW.member_subject
                                 AND m.revoked_at_utc IS NULL AND m.expires_at_utc > now()) THEN
                RAISE EXCEPTION 'the member has not accepted an invitation to this tenant and holds no grant here'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
        END IF;
        RETURN NEW;
    END IF;
    -- UPDATE: one decision, from awaiting approval, before the decision is due.
    IF (NEW.id, NEW.access_request_id, NEW.tenant_id, NEW.environment, NEW.member_issuer, NEW.member_subject,
        NEW.merchant_id, NEW.persona, NEW.effective_from_utc, NEW.expires_at_utc, NEW.purpose,
        NEW.requested_by_issuer, NEW.requested_by_subject, NEW.requested_at_utc, NEW.decision_due_at_utc)
       IS DISTINCT FROM
       (OLD.id, OLD.access_request_id, OLD.tenant_id, OLD.environment, OLD.member_issuer, OLD.member_subject,
        OLD.merchant_id, OLD.persona, OLD.effective_from_utc, OLD.expires_at_utc, OLD.purpose,
        OLD.requested_by_issuer, OLD.requested_by_subject, OLD.requested_at_utc, OLD.decision_due_at_utc) THEN
        RAISE EXCEPTION 'a request cannot change; reject it and make a new one' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status <> 'AWAITING_INDEPENDENT_APPROVAL' OR NEW.status NOT IN ('APPROVED','REJECTED') THEN
        RAISE EXCEPTION 'a request is decided once' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'a decision raises the version by exactly one' USING ERRCODE = 'restrict_violation';
    END IF;
    IF now() >= OLD.decision_due_at_utc THEN
        RAISE EXCEPTION 'the request has expired' USING ERRCODE = 'restrict_violation';
    END IF;
    NEW.decided_at_utc := now();
    IF NOT merchant.zp_is_provisioning() THEN
        -- The checker is an owner covering the request; an approver's own grant must also outlast it.
        IF NOT merchant.zp_owner_covers(NEW.tenant_id, NEW.environment, NEW.decided_by_issuer, NEW.decided_by_subject,
                                        NEW.merchant_id, CASE WHEN NEW.status = 'APPROVED' THEN NEW.expires_at_utc END) THEN
            RAISE EXCEPTION 'the decider''s owner grant does not cover this request' USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER access_request_guard BEFORE INSERT OR UPDATE OR DELETE ON merchant.access_requests
    FOR EACH ROW EXECUTE FUNCTION merchant.zp_access_request_guard();
CREATE TRIGGER access_request_guard_truncate BEFORE TRUNCATE ON merchant.access_requests
    FOR EACH STATEMENT EXECUTE FUNCTION merchant.zp_no_delete();

-- ---------------------------------------------------------------------------
-- Grants made from requests, and why a grant was revoked.
ALTER TABLE merchant.memberships
    ADD COLUMN access_request_id uuid NULL REFERENCES merchant.access_requests (id),
    ADD COLUMN revocation_reason text NULL
        CONSTRAINT revocation_reason_text CHECK (length(btrim(revocation_reason)) BETWEEN 1 AND 200 AND revocation_reason !~ 'eyJ'),
    ADD CONSTRAINT memberships_one_grant_per_request UNIQUE (access_request_id),
    ADD CONSTRAINT revocation_reason_with_revocation CHECK (revocation_reason IS NULL OR revoked_at_utc IS NOT NULL);

-- The guard now also fixes the public ID and the request a grant came from.
CREATE OR REPLACE FUNCTION merchant.zp_membership_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'memberships are never deleted; revoke them instead' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.id, NEW.issuer, NEW.subject, NEW.tenant_id, NEW.merchant_id, NEW.environment, NEW.persona,
        NEW.granted_by_issuer, NEW.granted_by_subject, NEW.approved_by_issuer, NEW.approved_by_subject, NEW.granted_at_utc,
        NEW.effective_from_utc, NEW.expires_at_utc, NEW.membership_id, NEW.access_request_id)
       IS DISTINCT FROM
       (OLD.id, OLD.issuer, OLD.subject, OLD.tenant_id, OLD.merchant_id, OLD.environment, OLD.persona,
        OLD.granted_by_issuer, OLD.granted_by_subject, OLD.approved_by_issuer, OLD.approved_by_subject, OLD.granted_at_utc,
        OLD.effective_from_utc, OLD.expires_at_utc, OLD.membership_id, OLD.access_request_id) THEN
        RAISE EXCEPTION 'a membership grant cannot change; revoke it and grant a new one' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.revoked_at_utc IS NOT NULL AND (NEW.revoked_at_utc, NEW.revoked_by_issuer, NEW.revoked_by_subject, NEW.revocation_reason)
       IS DISTINCT FROM (OLD.revoked_at_utc, OLD.revoked_by_issuer, OLD.revoked_by_subject, OLD.revocation_reason) THEN
        RAISE EXCEPTION 'a revocation is final' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;

-- Delegation rules for every role but provisioning: a new grant comes from an
-- approved request that matches it exactly; maker and checker still hold
-- covering owner grants that outlast it; owner grants are never created or
-- revoked here; a revocation is by an owner covering the grant.
CREATE FUNCTION merchant.zp_membership_delegation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    r merchant.access_requests%ROWTYPE;
BEGIN
    IF merchant.zp_is_provisioning() THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.persona = 'MOWN' THEN
            RAISE EXCEPTION 'owner grants are created only by tenant provisioning' USING ERRCODE = 'insufficient_privilege';
        END IF;
        SELECT * INTO r FROM merchant.access_requests WHERE id = NEW.access_request_id;
        IF NOT FOUND OR r.status <> 'APPROVED'
           OR r.tenant_id <> NEW.tenant_id OR r.environment <> NEW.environment
           OR r.member_issuer <> NEW.issuer OR r.member_subject <> NEW.subject
           OR r.merchant_id IS DISTINCT FROM NEW.merchant_id OR r.persona <> NEW.persona
           OR r.expires_at_utc <> NEW.expires_at_utc OR NEW.effective_from_utc < r.effective_from_utc
           OR (r.requested_by_issuer, r.requested_by_subject) <> (NEW.granted_by_issuer, NEW.granted_by_subject)
           OR (r.decided_by_issuer, r.decided_by_subject) <> (NEW.approved_by_issuer, NEW.approved_by_subject) THEN
            RAISE EXCEPTION 'a grant needs an approved access request that matches it exactly' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NOT merchant.zp_owner_covers(NEW.tenant_id, NEW.environment, NEW.granted_by_issuer, NEW.granted_by_subject,
                                        NEW.merchant_id, NEW.expires_at_utc)
           OR NOT merchant.zp_owner_covers(NEW.tenant_id, NEW.environment, NEW.approved_by_issuer, NEW.approved_by_subject,
                                           NEW.merchant_id, NEW.expires_at_utc) THEN
            RAISE EXCEPTION 'maker and checker must each hold a live owner grant that covers and outlasts this grant (never grant above the delegator)'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;
    -- UPDATE: a first revocation.
    IF OLD.revoked_at_utc IS NULL AND NEW.revoked_at_utc IS NOT NULL THEN
        IF OLD.persona = 'MOWN' THEN
            RAISE EXCEPTION 'owner grants are revoked only by tenant provisioning' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NOT merchant.zp_owner_covers(OLD.tenant_id, OLD.environment, NEW.revoked_by_issuer, NEW.revoked_by_subject,
                                        OLD.merchant_id, NULL) THEN
            RAISE EXCEPTION 'only an owner whose grant covers it can revoke this grant' USING ERRCODE = 'insufficient_privilege';
        END IF;
        NEW.revoked_at_utc := greatest(now(), OLD.granted_at_utc);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER membership_delegation BEFORE INSERT OR UPDATE ON merchant.memberships
    FOR EACH ROW EXECUTE FUNCTION merchant.zp_membership_delegation();

-- ---------------------------------------------------------------------------
-- Grant events (03-05 §14 GrantChanged): append-only, written only by the
-- triggers below, which run as the table owner. The runtime role can read
-- its tenant's events and nothing else.
CREATE TABLE merchant.grant_events (
    id                 uuid        PRIMARY KEY DEFAULT uuidv7() CHECK (uuid_extract_version(id) = 7),
    tenant_id          text        NOT NULL,
    environment        text        NOT NULL CHECK (environment IN ('TEST','LIVE')),
    event_type         text        NOT NULL CHECK (event_type IN ('INVITATION_CREATED','INVITATION_ACCEPTED',
                                       'ACCESS_REQUESTED','ACCESS_APPROVED','ACCESS_REJECTED','GRANT_CREATED','GRANT_REVOKED')),
    actor_issuer       text        NOT NULL,
    actor_subject      text        NOT NULL,
    member_issuer      text        NULL,
    member_subject     text        NULL,
    maker_issuer       text        NULL,
    maker_subject      text        NULL,
    approver_issuer    text        NULL,
    approver_subject   text        NULL,
    invitation_id      text        NULL,
    access_request_id  text        NULL,
    membership_id      text        NULL,
    persona            text        NULL,
    merchant_id        text        NULL,
    effective_from_utc timestamptz NULL,
    expires_at_utc     timestamptz NULL,
    purpose            text        NULL,
    reason             text        NULL,
    prior_version      bigint      NULL,
    new_version        bigint      NULL,
    occurred_at_utc    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX grant_events_by_tenant ON merchant.grant_events (tenant_id, environment, occurred_at_utc);
CREATE TRIGGER grant_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON merchant.grant_events
    FOR EACH STATEMENT EXECUTE FUNCTION merchant.zp_append_only();

CREATE FUNCTION merchant.zp_record_grant_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    req text;
BEGIN
    IF TG_TABLE_NAME = 'invitations' THEN
        IF TG_OP = 'INSERT' THEN
            INSERT INTO merchant.grant_events (tenant_id, environment, event_type, actor_issuer, actor_subject, invitation_id, expires_at_utc)
            VALUES (NEW.tenant_id, NEW.environment, 'INVITATION_CREATED', NEW.invited_by_issuer, NEW.invited_by_subject,
                    NEW.invitation_id, NEW.expires_at_utc);
        ELSIF OLD.accepted_at_utc IS NULL AND NEW.accepted_at_utc IS NOT NULL THEN
            INSERT INTO merchant.grant_events (tenant_id, environment, event_type, actor_issuer, actor_subject,
                                               member_issuer, member_subject, invitation_id)
            VALUES (NEW.tenant_id, NEW.environment, 'INVITATION_ACCEPTED', NEW.accepted_by_issuer, NEW.accepted_by_subject,
                    NEW.accepted_by_issuer, NEW.accepted_by_subject, NEW.invitation_id);
        END IF;
    ELSIF TG_TABLE_NAME = 'access_requests' THEN
        IF TG_OP = 'INSERT' THEN
            INSERT INTO merchant.grant_events (tenant_id, environment, event_type, actor_issuer, actor_subject, member_issuer,
                member_subject, maker_issuer, maker_subject, access_request_id, persona, merchant_id, effective_from_utc,
                expires_at_utc, purpose, new_version)
            VALUES (NEW.tenant_id, NEW.environment, 'ACCESS_REQUESTED', NEW.requested_by_issuer, NEW.requested_by_subject,
                NEW.member_issuer, NEW.member_subject, NEW.requested_by_issuer, NEW.requested_by_subject, NEW.access_request_id,
                NEW.persona, NEW.merchant_id, NEW.effective_from_utc, NEW.expires_at_utc, NEW.purpose, NEW.version);
        ELSIF OLD.status <> NEW.status THEN
            INSERT INTO merchant.grant_events (tenant_id, environment, event_type, actor_issuer, actor_subject, member_issuer,
                member_subject, maker_issuer, maker_subject, approver_issuer, approver_subject, access_request_id, persona,
                merchant_id, effective_from_utc, expires_at_utc, purpose, reason, prior_version, new_version)
            VALUES (NEW.tenant_id, NEW.environment, CASE NEW.status WHEN 'APPROVED' THEN 'ACCESS_APPROVED' ELSE 'ACCESS_REJECTED' END,
                NEW.decided_by_issuer, NEW.decided_by_subject, NEW.member_issuer, NEW.member_subject, NEW.requested_by_issuer,
                NEW.requested_by_subject, NEW.decided_by_issuer, NEW.decided_by_subject, NEW.access_request_id, NEW.persona,
                NEW.merchant_id, NEW.effective_from_utc, NEW.expires_at_utc, NEW.purpose, NEW.decision_reason, OLD.version, NEW.version);
        END IF;
    ELSE -- memberships
        SELECT a.access_request_id INTO req FROM merchant.access_requests a WHERE a.id = NEW.access_request_id;
        IF TG_OP = 'INSERT' THEN
            INSERT INTO merchant.grant_events (tenant_id, environment, event_type, actor_issuer, actor_subject, member_issuer,
                member_subject, maker_issuer, maker_subject, approver_issuer, approver_subject, access_request_id, membership_id,
                persona, merchant_id, effective_from_utc, expires_at_utc)
            VALUES (NEW.tenant_id, NEW.environment, 'GRANT_CREATED', NEW.approved_by_issuer, NEW.approved_by_subject,
                NEW.issuer, NEW.subject, NEW.granted_by_issuer, NEW.granted_by_subject, NEW.approved_by_issuer,
                NEW.approved_by_subject, req, NEW.membership_id, NEW.persona, NEW.merchant_id, NEW.effective_from_utc,
                NEW.expires_at_utc);
        ELSIF OLD.revoked_at_utc IS NULL AND NEW.revoked_at_utc IS NOT NULL THEN
            INSERT INTO merchant.grant_events (tenant_id, environment, event_type, actor_issuer, actor_subject, member_issuer,
                member_subject, access_request_id, membership_id, persona, merchant_id, effective_from_utc, expires_at_utc, reason)
            VALUES (NEW.tenant_id, NEW.environment, 'GRANT_REVOKED', NEW.revoked_by_issuer, NEW.revoked_by_subject,
                NEW.issuer, NEW.subject, req, NEW.membership_id, NEW.persona, NEW.merchant_id, NEW.effective_from_utc,
                NEW.expires_at_utc, NEW.revocation_reason);
        END IF;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER invitation_events AFTER INSERT OR UPDATE ON merchant.invitations
    FOR EACH ROW EXECUTE FUNCTION merchant.zp_record_grant_event();
CREATE TRIGGER access_request_events AFTER INSERT OR UPDATE ON merchant.access_requests
    FOR EACH ROW EXECUTE FUNCTION merchant.zp_record_grant_event();
CREATE TRIGGER membership_events AFTER INSERT OR UPDATE ON merchant.memberships
    FOR EACH ROW EXECUTE FUNCTION merchant.zp_record_grant_event();

-- ---------------------------------------------------------------------------
-- Row-level security, forced.
ALTER TABLE merchant.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant.invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merchant.invitations
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));
-- The invitee does not know the tenant: the token's hash, set for one
-- transaction, makes exactly that invitation visible and acceptable.
CREATE POLICY invitation_by_token ON merchant.invitations FOR SELECT
    USING (token_hash = CASE WHEN current_setting('zp.invitation_token_hash', true) ~ '^[0-9a-f]{64}$'
                             THEN decode(current_setting('zp.invitation_token_hash', true), 'hex') END);
CREATE POLICY accept_by_token ON merchant.invitations FOR UPDATE
    USING (token_hash = CASE WHEN current_setting('zp.invitation_token_hash', true) ~ '^[0-9a-f]{64}$'
                             THEN decode(current_setting('zp.invitation_token_hash', true), 'hex') END)
    WITH CHECK (token_hash = CASE WHEN current_setting('zp.invitation_token_hash', true) ~ '^[0-9a-f]{64}$'
                                  THEN decode(current_setting('zp.invitation_token_hash', true), 'hex') END);

ALTER TABLE merchant.access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant.access_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merchant.access_requests
    USING (tenant_id = current_setting('zp.tenant_id', true)) WITH CHECK (tenant_id = current_setting('zp.tenant_id', true));

ALTER TABLE merchant.grant_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant.grant_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merchant.grant_events FOR SELECT
    USING (tenant_id = current_setting('zp.tenant_id', true));
-- The event triggers run as the owner (zp_migrator), whatever the caller's context.
CREATE POLICY event_recorder ON merchant.grant_events FOR INSERT TO zp_migrator WITH CHECK (true);

-- Least privilege for zp_gateway.
GRANT SELECT, INSERT ON merchant.invitations TO zp_gateway;
GRANT UPDATE (accepted_by_issuer, accepted_by_subject, accepted_at_utc) ON merchant.invitations TO zp_gateway;
GRANT SELECT, INSERT ON merchant.access_requests TO zp_gateway;
GRANT UPDATE (status, decided_by_issuer, decided_by_subject, decided_at_utc, decision_reason, version)
    ON merchant.access_requests TO zp_gateway;
GRANT SELECT ON merchant.grant_events TO zp_gateway;
GRANT UPDATE (revocation_reason) ON merchant.memberships TO zp_gateway;

-- +goose StatementEnd
