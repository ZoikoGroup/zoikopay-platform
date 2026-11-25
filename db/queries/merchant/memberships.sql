-- BC-01 membership queries (sqlc).

-- name: LiveGrantsForSubject :many
-- The caller's live grants in every tenant and environment, read by the
-- principal resolver. Runs inside db.InSubjectTx: the own_active_memberships
-- policy already limits rows to this subject's live grants; the WHERE clause
-- repeats the rule with the application's clock (defence in depth).
SELECT id, issuer, subject, tenant_id, merchant_id, environment, persona, effective_from_utc, expires_at_utc
FROM merchant.memberships
WHERE issuer = @issuer AND subject = @subject
  AND revoked_at_utc IS NULL
  AND effective_from_utc <= @now AND expires_at_utc > @now
ORDER BY tenant_id, environment, merchant_id NULLS FIRST, persona;
