-- BC-01 grant administration queries (sqlc; OPEN_QUESTIONS Q40). Every query
-- runs as zp_gateway inside a tenant transaction (row-level security), except
-- InvitationByToken and AcceptInvitation, which run under the invitation
-- token's hash. The database re-checks every rule (00005_grant_administration.sql).

-- name: LiveOwnerGrants :many
-- A person's live owner (MOWN) grants in one tenant and environment.
SELECT merchant_id, expires_at_utc
FROM merchant.memberships
WHERE tenant_id = @tenant_id AND environment = @environment AND issuer = @issuer AND subject = @subject
  AND persona = 'MOWN' AND revoked_at_utc IS NULL
  AND effective_from_utc <= @now AND expires_at_utc > @now;

-- name: InsertInvitation :one
INSERT INTO merchant.invitations (invitation_id, tenant_id, environment, token_hash, invited_by_issuer, invited_by_subject, expires_at_utc)
VALUES (@invitation_id, @tenant_id, @environment, @token_hash, @invited_by_issuer, @invited_by_subject, @expires_at_utc)
RETURNING *;

-- name: GetInvitation :one
SELECT * FROM merchant.invitations
WHERE invitation_id = @invitation_id AND tenant_id = @tenant_id AND environment = @environment;

-- name: ListInvitations :many
SELECT * FROM merchant.invitations
WHERE tenant_id = @tenant_id AND environment = @environment
ORDER BY created_at_utc DESC, id DESC
LIMIT 200;

-- name: InvitationByToken :one
SELECT * FROM merchant.invitations WHERE token_hash = @token_hash FOR UPDATE;

-- name: AcceptInvitation :one
UPDATE merchant.invitations
SET accepted_by_issuer = @accepted_by_issuer, accepted_by_subject = @accepted_by_subject, accepted_at_utc = now()
WHERE token_hash = @token_hash AND accepted_at_utc IS NULL
RETURNING *;

-- name: InsertAccessRequest :one
INSERT INTO merchant.access_requests
    (access_request_id, tenant_id, environment, member_issuer, member_subject, merchant_id, persona,
     effective_from_utc, expires_at_utc, purpose, requested_by_issuer, requested_by_subject, decision_due_at_utc)
VALUES (@access_request_id, @tenant_id, @environment, @member_issuer, @member_subject, sqlc.narg(merchant_id), @persona,
        @effective_from_utc, @expires_at_utc, @purpose, @requested_by_issuer, @requested_by_subject, @decision_due_at_utc)
RETURNING *;

-- name: GetAccessRequest :one
SELECT r.*, m.membership_id AS granted_membership_id
FROM merchant.access_requests r
LEFT JOIN merchant.memberships m ON m.access_request_id = r.id
WHERE r.access_request_id = @access_request_id AND r.tenant_id = @tenant_id AND r.environment = @environment;

-- name: LockAccessRequest :one
SELECT * FROM merchant.access_requests
WHERE access_request_id = @access_request_id AND tenant_id = @tenant_id AND environment = @environment
FOR UPDATE;

-- name: ListAccessRequests :many
SELECT r.*, m.membership_id AS granted_membership_id
FROM merchant.access_requests r
LEFT JOIN merchant.memberships m ON m.access_request_id = r.id
WHERE r.tenant_id = @tenant_id AND r.environment = @environment
ORDER BY r.requested_at_utc DESC, r.id DESC
LIMIT 200;

-- name: DecideAccessRequest :one
UPDATE merchant.access_requests
SET status = @status, decided_by_issuer = @decided_by_issuer, decided_by_subject = @decided_by_subject,
    decided_at_utc = now(), decision_reason = sqlc.narg(decision_reason), version = version + 1
WHERE id = @id AND version = @version
RETURNING *;

-- name: InsertGrantFromRequest :one
-- The grant an approval creates: exactly the request's member, scope, persona
-- and end, from the later of its start and now (the database checks the match).
INSERT INTO merchant.memberships
    (id, issuer, subject, tenant_id, merchant_id, environment, persona, granted_by_issuer, granted_by_subject,
     approved_by_issuer, approved_by_subject, granted_at_utc, effective_from_utc, expires_at_utc, access_request_id)
SELECT uuidv7(), r.member_issuer, r.member_subject, r.tenant_id, r.merchant_id, r.environment, r.persona,
       r.requested_by_issuer, r.requested_by_subject, r.decided_by_issuer, r.decided_by_subject,
       now(), greatest(r.effective_from_utc, now()), r.expires_at_utc, r.id
FROM merchant.access_requests r
WHERE r.id = @id
RETURNING membership_id;

-- name: GetMembership :one
SELECT m.*, r.access_request_id AS request_public_id
FROM merchant.memberships m
LEFT JOIN merchant.access_requests r ON r.id = m.access_request_id
WHERE m.membership_id = @membership_id AND m.tenant_id = @tenant_id AND m.environment = @environment;

-- name: LockMembership :one
SELECT * FROM merchant.memberships
WHERE membership_id = @membership_id AND tenant_id = @tenant_id AND environment = @environment
FOR UPDATE;

-- name: ListLiveMemberships :many
SELECT m.*, r.access_request_id AS request_public_id
FROM merchant.memberships m
LEFT JOIN merchant.access_requests r ON r.id = m.access_request_id
WHERE m.tenant_id = @tenant_id AND m.environment = @environment
  AND m.revoked_at_utc IS NULL AND m.expires_at_utc > @now
ORDER BY m.merchant_id NULLS FIRST, m.persona, m.granted_at_utc, m.id
LIMIT 500;

-- name: RevokeMembership :one
UPDATE merchant.memberships
SET revoked_at_utc = now(), revoked_by_issuer = @revoked_by_issuer, revoked_by_subject = @revoked_by_subject,
    revocation_reason = @revocation_reason
WHERE id = @id AND revoked_at_utc IS NULL
RETURNING membership_id;
