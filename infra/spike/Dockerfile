# Build context is the REPO ROOT (same reasoning as apps/api/Dockerfile: this needs
# @crop/api's own node_modules for `ws`/`tsx`, since that's the workspace this script is
# normally run from -- see infra/spike/mock-pikvm-server.ts's own docstring). On Railway,
# set this service's Dockerfile path to `infra/spike/Dockerfile`, root directory to `.`.
#
# This is the PiKVM test double used to demo the whole platform without real hardware --
# see docs/architecture.md and README.md's "No PiKVM hardware available?" section. It is
# NOT a full simulator; real video decode will show an error in the browser, everything
# else works.
FROM node:20-bookworm-slim

# python3/make/g++: this install pulls in the whole workspace's deps, including @crop/api's
# argon2 -- which needs these to compile if no prebuilt binary matches this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/pikvm/package.json packages/pikvm/package.json
RUN pnpm install --frozen-lockfile

COPY infra/spike/mock-pikvm-server.ts infra/spike/mock-pikvm-server.ts

ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 8443

CMD ["pnpm", "exec", "tsx", "../../infra/spike/mock-pikvm-server.ts"]
