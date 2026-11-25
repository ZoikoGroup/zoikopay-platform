-- name: GetMerchant :one
-- Runs inside a tenant transaction (authz.InTenantTx): there is deliberately
-- no tenant filter here, because row-level security limits the rows to the
-- transaction's tenant. The environment is the deployment's (Q36 36.16).
SELECT merchant_id, tenant_id, environment, display_name, status, revision, created_at_utc, updated_at_utc
FROM merchant.merchants
WHERE merchant_id = @merchant_id AND environment = @environment;
