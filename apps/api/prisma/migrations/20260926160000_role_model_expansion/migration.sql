-- Expands UserRole to cover the clinic side of the business (CLINIC_ADMIN already existed;
-- LOCAL_SUPERVISOR, NURSING and LOCAL_IT are new) alongside the operator-provider side
-- (OPERATOR already existed; OPERATOR_ADMIN is new, and the old bare SUPERVISOR is renamed to
-- OPERATIONAL_SUPERVISOR now that the clinic side has its own, distinct LOCAL_SUPERVISOR).
--
-- Hand-written rather than `prisma migrate dev`-generated: Prisma's diff engine has no concept
-- of renaming an enum value -- given a `schema.prisma` where SUPERVISOR became
-- OPERATIONAL_SUPERVISOR, it would emit a new type + column rewrite (or refuse), not the
-- `RENAME VALUE` below. `RENAME VALUE` is what actually preserves every existing supervisor's
-- role: their `users.role` column value, plus every hardcoded permission array that already
-- says `UserRole.SUPERVISOR` in code review history, carries over automatically because the
-- underlying enum label -- not any row -- is what's being renamed.
--
-- `ADD VALUE` is safe inside this migration's transaction on Postgres >= 12 as long as no row
-- written by *this same migration* uses the new value yet -- true here, since these are purely
-- additive labels with no data backfill.
-- BEFORE/AFTER positions the new labels to match schema.prisma's declared order exactly
-- (PLATFORM_ADMIN, CLINIC_ADMIN, LOCAL_SUPERVISOR, NURSING, LOCAL_IT, OPERATOR_ADMIN,
-- OPERATIONAL_SUPERVISOR, OPERATOR, AUDITOR) -- Postgres enums have a real, comparable
-- ordering, and leaving new values to default to "appended at the end" would create a
-- mismatch `prisma migrate diff` would flag against the schema for no functional reason.
ALTER TYPE "UserRole" RENAME VALUE 'SUPERVISOR' TO 'OPERATIONAL_SUPERVISOR';
ALTER TYPE "UserRole" ADD VALUE 'LOCAL_SUPERVISOR' AFTER 'CLINIC_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'NURSING' AFTER 'LOCAL_SUPERVISOR';
ALTER TYPE "UserRole" ADD VALUE 'LOCAL_IT' AFTER 'NURSING';
ALTER TYPE "UserRole" ADD VALUE 'OPERATOR_ADMIN' AFTER 'LOCAL_IT';
