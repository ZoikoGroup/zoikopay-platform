-- LOCAL DEVELOPMENT SEED. SYNTHETIC DATA ONLY: fictional organisations and the
-- local Keycloak realm's merchant users. Never run it against a shared or
-- production database. Run with `make seed-local` after `make up` and `make migrate`.
--
-- Why it exists (OPEN_QUESTIONS Q39 1(a)): the console reads roles only from
-- merchant.memberships through the gateway. These tenants and merchants use
-- the same IDs as the console's TEST fixtures (backend/src/database/fixtures.ts;
-- backend/test/seed.test.ts checks they match), so a merchant user's grant
-- covers the fixture data they see.
--
-- Runs as the provisioning role, the database superuser (Q40): owner (MOWN)
-- grants, and grants made without an approved access request, come only from
-- tenant provisioning (05-03, not built), never from the runtime role. Table
-- CHECKs and triggers still apply. Northwind gets two owners, so grant
-- administration (invite, request, approve) has an independent checker; the
-- other merchant users' grants name those two owners as maker and checker.
-- Platform staff get no grant (36.1, 39.3). Each grant is valid for 30 days
-- from the run (39.11).
--
-- Re-runnable: existing rows are kept; an expired grant here is revoked and
-- replaced, and a revoked one is replaced by a new grant (a revocation is
-- final, so access comes back only as a new grant).

\set ON_ERROR_STOP on
\set issuer 'http://localhost:8180/realms/zoikopay'

-- Northwind: merchant.owner and merchant.owner.b (MOWN, all merchants),
-- merchant.ops (MOPS, UK), merchant.finance (MFIN, all merchants),
-- merchant.dev (MDEV, UK).
BEGIN;
INSERT INTO merchant.tenants (id, tenant_id, display_name, created_at_utc, updated_at_utc)
VALUES (uuidv7(), 'ten_019a0000000170008000000000000001', 'Northwind', now(), now())
ON CONFLICT (tenant_id) DO NOTHING;
INSERT INTO merchant.merchants (id, merchant_id, tenant_id, environment, display_name, status, revision, created_at_utc, updated_at_utc)
VALUES
  (uuidv7(), 'mer_019a0000010170008000000000000101', 'ten_019a0000000170008000000000000001', 'TEST', 'Northwind Outfitters UK', 'VERIFIED', 1, now(), now()),
  (uuidv7(), 'mer_019a0000010270008000000000000102', 'ten_019a0000000170008000000000000001', 'TEST', 'Northwind Outfitters EU', 'VERIFIED', 1, now(), now())
ON CONFLICT (merchant_id) DO NOTHING;
-- An expired grant still blocks a new one (one active grant per scope), so revoke it first.
UPDATE merchant.memberships SET revoked_at_utc = now(), revoked_by_issuer = :'issuer', revoked_by_subject = 'zp-local-seed-checker'
WHERE tenant_id = 'ten_019a0000000170008000000000000001' AND revoked_at_utc IS NULL AND expires_at_utc <= now();
WITH g(subject, tenant_id, merchant_id, persona, maker, checker) AS (VALUES
  ('00000000-0000-4000-8000-000000000010', 'ten_019a0000000170008000000000000001', NULL::text, 'MOWN', 'zp-local-seed-maker', 'zp-local-seed-checker'),
  ('00000000-0000-4000-8000-000000000019', 'ten_019a0000000170008000000000000001', NULL::text, 'MOWN', 'zp-local-seed-maker', 'zp-local-seed-checker'),
  ('00000000-0000-4000-8000-000000000011', 'ten_019a0000000170008000000000000001', 'mer_019a0000010170008000000000000101', 'MOPS', 'owner-a', 'owner-b'),
  ('00000000-0000-4000-8000-000000000014', 'ten_019a0000000170008000000000000001', NULL::text, 'MFIN', 'owner-a', 'owner-b'),
  ('00000000-0000-4000-8000-000000000015', 'ten_019a0000000170008000000000000001', 'mer_019a0000010170008000000000000101', 'MDEV', 'owner-a', 'owner-b')
), people(alias, subject) AS (VALUES
  -- maker and checker of the non-owner grants: Northwind's two owners
  ('owner-a', '00000000-0000-4000-8000-000000000010'), ('owner-b', '00000000-0000-4000-8000-000000000019')
)
INSERT INTO merchant.memberships (id, issuer, subject, tenant_id, merchant_id, environment, persona,
  granted_by_issuer, granted_by_subject, approved_by_issuer, approved_by_subject, granted_at_utc, effective_from_utc, expires_at_utc)
SELECT uuidv7(), :'issuer', g.subject, g.tenant_id, g.merchant_id, 'TEST', g.persona,
  :'issuer', coalesce(mk.subject, g.maker), :'issuer', coalesce(ck.subject, g.checker), now(), now(),
  -- owners last a day longer, so the grants they made never outlast them
  now() + CASE g.persona WHEN 'MOWN' THEN interval '31 days' ELSE interval '30 days' END
FROM g
LEFT JOIN people mk ON mk.alias = g.maker
LEFT JOIN people ck ON ck.alias = g.checker
WHERE NOT EXISTS (SELECT 1 FROM merchant.memberships m
  WHERE m.issuer = :'issuer' AND m.subject = g.subject AND m.tenant_id = g.tenant_id
    AND m.merchant_id IS NOT DISTINCT FROM g.merchant_id AND m.persona = g.persona AND m.environment = 'TEST'
    AND m.revoked_at_utc IS NULL AND m.expires_at_utc > now());
COMMIT;

-- Alder: merchant.viewer (MVIEW, all merchants). Alder has no owner.
BEGIN;
INSERT INTO merchant.tenants (id, tenant_id, display_name, created_at_utc, updated_at_utc)
VALUES (uuidv7(), 'ten_019a0000000270008000000000000002', 'Alder', now(), now())
ON CONFLICT (tenant_id) DO NOTHING;
INSERT INTO merchant.merchants (id, merchant_id, tenant_id, environment, display_name, status, revision, created_at_utc, updated_at_utc)
VALUES
  (uuidv7(), 'mer_019a0000020170008000000000000201', 'ten_019a0000000270008000000000000002', 'TEST', 'Alder Books', 'VERIFIED', 1, now(), now()),
  (uuidv7(), 'mer_019a0000020270008000000000000202', 'ten_019a0000000270008000000000000002', 'TEST', 'Alder Travel', 'VERIFIED', 1, now(), now())
ON CONFLICT (merchant_id) DO NOTHING;
UPDATE merchant.memberships SET revoked_at_utc = now(), revoked_by_issuer = :'issuer', revoked_by_subject = 'zp-local-seed-checker'
WHERE tenant_id = 'ten_019a0000000270008000000000000002' AND revoked_at_utc IS NULL AND expires_at_utc <= now();
WITH g(subject, tenant_id, merchant_id, persona) AS (VALUES
  ('00000000-0000-4000-8000-000000000012', 'ten_019a0000000270008000000000000002', NULL::text, 'MVIEW')
)
INSERT INTO merchant.memberships (id, issuer, subject, tenant_id, merchant_id, environment, persona,
  granted_by_issuer, granted_by_subject, approved_by_issuer, approved_by_subject, granted_at_utc, effective_from_utc, expires_at_utc)
SELECT uuidv7(), :'issuer', g.subject, g.tenant_id, g.merchant_id, 'TEST', g.persona,
  :'issuer', 'zp-local-seed-maker', :'issuer', 'zp-local-seed-checker', now(), now(), now() + interval '30 days'
FROM g
WHERE NOT EXISTS (SELECT 1 FROM merchant.memberships m
  WHERE m.issuer = :'issuer' AND m.subject = g.subject AND m.tenant_id = g.tenant_id
    AND m.merchant_id IS NOT DISTINCT FROM g.merchant_id AND m.persona = g.persona AND m.environment = 'TEST'
    AND m.revoked_at_utc IS NULL AND m.expires_at_utc > now());
COMMIT;

-- Kestrel: an organisation with no members, so nobody sees it.
BEGIN;
INSERT INTO merchant.tenants (id, tenant_id, display_name, created_at_utc, updated_at_utc)
VALUES (uuidv7(), 'ten_019a0000000370008000000000000003', 'Kestrel', now(), now())
ON CONFLICT (tenant_id) DO NOTHING;
INSERT INTO merchant.merchants (id, merchant_id, tenant_id, environment, display_name, status, revision, created_at_utc, updated_at_utc)
VALUES
  (uuidv7(), 'mer_019a0000030170008000000000000301', 'ten_019a0000000370008000000000000003', 'TEST', 'Kestrel Studio UK', 'VERIFIED', 1, now(), now()),
  (uuidv7(), 'mer_019a0000030270008000000000000302', 'ten_019a0000000370008000000000000003', 'TEST', 'Kestrel Studio EU', 'VERIFIED', 1, now(), now())
ON CONFLICT (merchant_id) DO NOTHING;
COMMIT;

-- What the merchant users now hold.
SELECT t.display_name AS tenant, m.subject, m.persona, coalesce(m.merchant_id, '(all merchants)') AS merchant, m.expires_at_utc
FROM merchant.memberships m JOIN merchant.tenants t USING (tenant_id)
WHERE m.revoked_at_utc IS NULL AND m.expires_at_utc > now()
ORDER BY t.display_name, m.subject, m.persona;
