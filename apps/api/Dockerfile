# Build context is the REPO ROOT, not apps/api -- this needs to see sibling workspace
# packages (packages/shared, packages/pikvm) to build @crop/api at all. On Railway (or any
# host), set this service's Dockerfile path to `apps/api/Dockerfile` while keeping its build
# context/root directory at the repo root. See DEPLOY.md.
#
# One image, one build stage, deliberately not multi-stage: pnpm's workspace node_modules
# layout is a tree of real symlinks between the root node_modules, each workspace package's
# OWN node_modules, and a shared virtual store (node_modules/.pnpm) -- selectively copying
# only "the parts a running Nest app needs" across stages is exactly the kind of thing that
# looks like it works until one transitive dependency's symlink target didn't get copied.
# Shipping the whole build environment forward is a few hundred extra MB; for a demo, that's
# a better trade than a container that mysteriously can't resolve a module three tenants
# into launch day.
FROM node:20-bookworm-slim

# python3/make/g++: argon2 ships prebuilt native bindings for common platforms only --
# without these, `pnpm install` falls back to compiling it from source and fails outright.
# openssl: Prisma's query engine needs to detect the installed libssl version at install
# time; without it present, Prisma silently guesses (and can guess wrong).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Copy just the manifests first so `pnpm install` is cached across builds unless a
# package.json or the lockfile actually changed -- avoids reinstalling on every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/pikvm/package.json packages/pikvm/package.json
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @crop/api exec prisma generate
RUN pnpm turbo run build --filter=@crop/api...

RUN chmod +x apps/api/docker-entrypoint.sh

ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
