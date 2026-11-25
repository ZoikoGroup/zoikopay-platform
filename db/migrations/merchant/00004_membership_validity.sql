-- +goose Up
-- Grant validity window for tenant memberships (OPEN_QUESTIONS Q36 decision
-- 36.6): "Every grant has version, signed approver, purpose, effective_from,
-- expires_at and revoke timestamp" (03-05 §13.1); tenant_membership has
-- expires_at (02-02 §6.1). There is no open-ended grant and no maximum is
-- invented (36.7). Both columns are immutable, like the rest of a grant.
--
-- The columns are NOT NULL without a default: merchant.memberships has never
-- held rows outside throwaway test databases (no environment has applied
-- these migrations), so there is nothing to backfill, and a default would
-- invent a validity window for someone.
-- +goose StatementBegin

ALTER TABLE merchant.memberships
    ADD COLUMN effective_from_utc timestamptz NOT NULL,
    ADD COLUMN expires_at_utc     timestamptz NOT NULL,
    ADD CONSTRAINT validity_window_ordered CHECK (expires_at_utc > effective_from_utc),
    ADD CONSTRAINT effective_after_granted CHECK (effective_from_utc >= granted_at_utc);

-- The guard now also fixes the validity window: extending or back-dating a
-- grant would be a new grant without a new maker and checker.
CREATE OR REPLACE FUNCTION merchant.zp_membership_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'memberships are never deleted; revoke them instead' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.id, NEW.issuer, NEW.subject, NEW.tenant_id, NEW.merchant_id, NEW.environment, NEW.persona,
        NEW.granted_by_issuer, NEW.granted_by_subject, NEW.approved_by_issuer, NEW.approved_by_subject, NEW.granted_at_utc,
        NEW.effective_from_utc, NEW.expires_at_utc)
       IS DISTINCT FROM
       (OLD.id, OLD.issuer, OLD.subject, OLD.tenant_id, OLD.merchant_id, OLD.environment, OLD.persona,
        OLD.granted_by_issuer, OLD.granted_by_subject, OLD.approved_by_issuer, OLD.approved_by_subject, OLD.granted_at_utc,
        OLD.effective_from_utc, OLD.expires_at_utc) THEN
        RAISE EXCEPTION 'a membership grant cannot change; revoke it and grant a new one' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.revoked_at_utc IS NOT NULL AND (NEW.revoked_at_utc, NEW.revoked_by_issuer, NEW.revoked_by_subject)
       IS DISTINCT FROM (OLD.revoked_at_utc, OLD.revoked_by_issuer, OLD.revoked_by_subject) THEN
        RAISE EXCEPTION 'a revocation is final' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;

-- The caller's own-grants lookup shows only live grants: unrevoked and inside
-- their validity window (36.5). now() is the transaction start time. The
-- resolver checks the window again with its own clock.
ALTER POLICY own_active_memberships ON merchant.memberships
    USING (revoked_at_utc IS NULL
           AND effective_from_utc <= now() AND expires_at_utc > now()
           AND issuer = current_setting('zp.subject_issuer', true)
           AND subject = current_setting('zp.subject', true));

-- +goose StatementEnd
