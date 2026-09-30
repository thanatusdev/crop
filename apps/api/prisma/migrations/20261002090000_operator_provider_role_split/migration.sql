-- Role-model inversion: operator-side accounts move out of CLINIC tenants.
--
-- `ROLE_TENANT_TYPES` (packages/shared/src/roles.ts) now confines OPERATOR,
-- OPERATIONAL_SUPERVISOR and OPERATOR_ADMIN to OPERATOR_PROVIDER tenants. That invariant is
-- enforced by `RegisterUserHandler` at *registration* time only, so without this migration
-- every pre-existing operator account would keep working while being, by the current rules,
-- impossible to re-create -- exactly the kind of silently-illegal row that makes a later
-- constraint or backfill unsafe.
--
-- This is a pure data migration: no schema change. `Tenant.operatorTenantId` already exists
-- and is already honored by ClinicAccessChecker; this migration is what starts populating it
-- for real, and the same commit widens SwitchActiveClinicHandler/ListMyClinicsHandler to
-- honor it too, which is what keeps the moved accounts functional.
--
-- ONE PROVIDER PER CLINIC, deliberately, not one shared provider for everybody. A single
-- shared OPERATOR_PROVIDER tenant would make every migrated operator reachable into every
-- migrated clinic, because access is granted per (clinic -> operator tenant) link. That is a
-- privilege escalation invented by a migration, which is never acceptable. Giving each
-- affected clinic its own provider tenant reproduces the pre-migration topology exactly: the
-- operators who could reach precisely one clinic still reach precisely that one clinic.
--
-- Idempotent: re-running is a no-op, since after the first run no operator-side user has a
-- CLINIC home tenant and the NOT EXISTS guard stops a second provider being created.

-- 1. One OPERATOR_PROVIDER tenant per clinic that currently hosts operator-side users.
--    `cnpj` is left NULL: it is UNIQUE, and a fabricated value would collide or, worse, look
--    like a real registration. The schema already documents cnpj as nullable for
--    non-CLINIC tenants.
INSERT INTO tenants (id, name, type, "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  c.name || ' - Operacao Remota',
  'OPERATOR_PROVIDER',
  now(),
  now()
FROM tenants c
WHERE c.type = 'CLINIC'
  AND EXISTS (
    SELECT 1 FROM users u
    WHERE u."tenantId" = c.id
      AND u.role IN ('OPERATOR', 'OPERATIONAL_SUPERVISOR', 'OPERATOR_ADMIN')
  )
  AND c."operatorTenantId" IS NULL;

-- 2. Link each affected clinic to the provider tenant just created for it. Matched by the
--    derived name, which is unique per clinic because clinic ids are -- and step 1 only ran
--    for clinics whose `operatorTenantId` was still NULL, so no existing link is overwritten.
UPDATE tenants c
SET "operatorTenantId" = p.id,
    "updatedAt" = now()
FROM tenants p
WHERE c.type = 'CLINIC'
  AND c."operatorTenantId" IS NULL
  AND p.type = 'OPERATOR_PROVIDER'
  AND p.name = c.name || ' - Operacao Remota';

-- 3. Move the operator-side users into their clinic's provider tenant.
UPDATE users u
SET "tenantId" = c."operatorTenantId"
FROM tenants c
WHERE u."tenantId" = c.id
  AND c.type = 'CLINIC'
  AND c."operatorTenantId" IS NOT NULL
  AND u.role IN ('OPERATOR', 'OPERATIONAL_SUPERVISOR', 'OPERATOR_ADMIN');

-- 4. Drop clinic memberships for the moved accounts. `UserClinicMembership` means "a
--    clinic-side user who works at these clinics" (see UserClinicMembershipRepositoryPort,
--    and RegisterUserHandler, which only ever grants rows for a CLINIC home tenant). An
--    operator's reach now comes from the operator link in step 2 instead, so leaving these
--    rows behind would create a second, redundant grant path that nothing maintains.
DELETE FROM user_clinic_memberships m
USING users u
WHERE m."userId" = u.id
  AND u.role IN ('OPERATOR', 'OPERATIONAL_SUPERVISOR', 'OPERATOR_ADMIN');

-- 5. A clinic cannot be its own operator. Not reachable from the steps above (step 1 only
--    inserts OPERATOR_PROVIDER rows), but this is the invariant the whole model rests on, so
--    it is asserted rather than assumed.
DO $$
DECLARE offending integer;
BEGIN
  SELECT count(*) INTO offending FROM tenants WHERE "operatorTenantId" = id;
  IF offending > 0 THEN
    RAISE EXCEPTION 'operator_provider_role_split: % tenant(s) reference themselves as operator', offending;
  END IF;
END $$;

-- 6. Assert the migration achieved its purpose: no operator-side user may remain in a CLINIC
--    (or PLATFORM) tenant. Failing loudly here is the point -- a silent partial migration
--    would leave accounts that violate ROLE_TENANT_TYPES and cannot be recreated.
DO $$
DECLARE stranded integer;
BEGIN
  SELECT count(*) INTO stranded
  FROM users u
  JOIN tenants t ON t.id = u."tenantId"
  WHERE u.role IN ('OPERATOR', 'OPERATIONAL_SUPERVISOR', 'OPERATOR_ADMIN')
    AND t.type <> 'OPERATOR_PROVIDER';
  IF stranded > 0 THEN
    RAISE EXCEPTION 'operator_provider_role_split: % operator-side user(s) left outside an OPERATOR_PROVIDER tenant', stranded;
  END IF;
END $$;
