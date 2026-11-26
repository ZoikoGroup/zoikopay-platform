-- BC-08 audit queries (sqlc). Run as zp_audit (OPEN_QUESTIONS Q38).

-- name: InsertAuditEvent :exec
-- id and occurred_at_utc are placeholders: the audit_events_stamp trigger
-- replaces both with the database's own values. A tenant entry must run inside
-- that tenant's transaction (row-level security WITH CHECK).
INSERT INTO governance.audit_events (
    id, occurred_at_utc, trace_id, actor_issuer, actor_subject, environment, tenant_id,
    action, resource_type, resource_hash, outcome, http_status, reason)
VALUES (
    uuidv7(), now(), @trace_id, sqlc.narg(actor_issuer), sqlc.narg(actor_subject), @environment, sqlc.narg(tenant_id),
    @action, sqlc.narg(resource_type), sqlc.narg(resource_hash), @outcome, @http_status, sqlc.narg(reason));

-- name: ListTenantAuditEvents :many
-- Runs inside the tenant's transaction: row-level security limits rows to
-- that tenant; the WHERE clause repeats it.
SELECT occurred_at_utc, trace_id, actor_issuer, actor_subject, environment, tenant_id,
       action, resource_type, resource_hash, outcome, http_status, reason
FROM governance.audit_events
WHERE tenant_id = @tenant_id AND environment = @environment
ORDER BY occurred_at_utc DESC, id DESC
LIMIT @max_rows;
