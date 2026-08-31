#!/bin/sh
# Runs at container start (not build time -- DATABASE_URL is only known once the container
# is actually running against a real deployed Postgres). Fails loudly and refuses to start
# the server if migrations don't apply cleanly, rather than serving traffic against a schema
# it doesn't match.
set -e

echo "Applying database migrations..."
pnpm exec prisma migrate deploy --schema=./prisma/schema.prisma

echo "Starting CROP API..."
exec node dist/main.js
