-- AlterTable: password policy + rotation columns on users.
--
-- `passwordChangedAt` defaults to CURRENT_TIMESTAMP (the moment this migration runs), NOT
-- backfilled from `createdAt` -- see schema.prisma's own comment on why: doing so would
-- instantly expire every account that predates this feature the moment PASSWORD_MAX_AGE_DAYS
-- enforcement went live.
ALTER TABLE "users"
  ADD COLUMN "firstName" TEXT,
  ADD COLUMN "lastName" TEXT,
  ADD COLUMN "professionalRegistration" TEXT,
  ADD COLUMN "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "password_history" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "password_history_userId_createdAt_idx" ON "password_history"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed one history row per existing user from their current hash, so a first self-service
-- reset can't "rotate" straight back to the password already in use -- without this, every
-- account that existed before this migration would have an empty history and the reuse
-- check would trivially pass on the very next reset.
--
-- gen_random_uuid() is a PostgreSQL 13+ built-in (no pgcrypto extension needed, confirmed
-- against this project's postgres:15-alpine) -- ids are otherwise generated client-side by
-- Prisma (see every other table's own `id` column, which carries no DB-level default), so
-- this is the one place a migration itself has to produce one.
INSERT INTO "password_history" ("id", "userId", "passwordHash", "createdAt")
  SELECT gen_random_uuid(), "id", "passwordHash", "createdAt" FROM "users";
