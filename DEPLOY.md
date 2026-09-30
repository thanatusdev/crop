# Deploying CROP for a demo

Live reference (this repo's own demo, deployed exactly per this file):
- Frontend: https://crop-demo-frontend.netlify.app
- API: https://crop-api-production-b1bb.up.railway.app

**Railway** hosts the three stateful pieces (API, mock PiKVM, Postgres, Redis); **Netlify**
hosts the static frontend. Both have generous free/trial tiers and neither requires a
credit card to start.

## Why Railway + Netlify

The API holds long-lived WebSocket connections (Socket.io on `/rt` for HID control, a raw
`ws` relay on `/stream` for video) on the *same* HTTP server as its REST routes -- see
`apps/api/src/modules/sessions/infrastructure/media-stream-server.ts`. That rules out
serverless/functions hosting for it; it needs a real, always-running container. The frontend
is a plain static SPA (Vite build) with no such requirement, so it gets its own simpler,
free static host rather than being served out of the same container as the API.

## Prerequisites

```bash
curl -fsSL railway.com/install.sh | sh   # or: brew install railway / npm i -g @railway/cli
railway login
```

Netlify's CLI needs no separate install -- every command below runs it via `npx netlify`
(auto-installs on first use). `netlify login` the same way if you're not already.

## 1. Railway: project, Postgres, Redis

```bash
railway init --name crop-demo
railway add --database postgres
railway add --database redis
```

## 2. Railway: the two app services, via Infrastructure-as-Code

This repo's GitHub App authorization for Railway may not exist yet on your account (a
one-time browser step) -- rather than deal with that, both services are declared in
`.railway/railway.ts` and deployed straight from local source. No GitHub connection needed
at all.

```bash
pnpm add -D -w railway   # the `railway/iac` SDK .railway/railway.ts imports
railway config plan      # preview -- should show 2 services to add, nothing destructive
railway config apply --yes
```

This creates `mock-pikvm` (builds `infra/spike/Dockerfile`, no public networking -- only
reachable from other services on Railway's private network) and `crop-api` (builds
`apps/api/Dockerfile`), both with build settings pre-configured. Review
`.railway/railway.ts` before running `apply` on your own project -- it also carries the
`DATABASE_URL`/`REDIS_URL` references and (after your first `apply`) `CORS_ORIGIN`/JWT
secrets as `preserve()` placeholders, never as plaintext.

Now push the actual code and build it:

```bash
railway up --service mock-pikvm --ci
railway up --service crop-api --ci
railway domain --service crop-api   # generates the public *.up.railway.app URL
```

`railway logs --service crop-api --lines 40` should show `Connected to PostgreSQL`,
`Connected to Redis`, and `RadLink API listening on :<port>` (Railway assigns its own `PORT`;
the app already honors whatever it's given, see `env.validation.ts`). Confirm from outside:

```bash
curl https://<your-api>.up.railway.app/metrics   # expect 200, Prometheus text output
```

**Setting the real secrets**: `.railway/railway.ts`'s `preserve()` placeholders mean the IaC
file itself doesn't set them -- set real values once via the CLI (never commit these):

```bash
railway variables --service crop-api --set "JWT_ACCESS_SECRET=$(openssl rand -hex 32)"
railway variables --service crop-api --set "JWT_REFRESH_SECRET=$(openssl rand -hex 32)"
railway variables --service crop-api --set "CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -base64 32)"
```

(`CORS_ORIGIN` comes in step 5, once the frontend's URL actually exists.)

## 3. Seed demo data against the deployed mock PiKVM

`railway run` injects that service's env vars but runs *locally* -- it does **not** tunnel
into Railway's private network, so `*.railway.internal` hostnames won't resolve and this
will fail with `ENOTFOUND`/`P1001`. Use `railway ssh` instead, which actually executes
inside the running container, where those hostnames work correctly:

```bash
railway ssh -s crop-api -- sh -c \
  "SEED_PIKVM_HOST=http://mock-pikvm.railway.internal:8443 SEED_PIKVM_USER=admin SEED_PIKVM_PASSWORD=admin \
   pnpm exec tsx ../../infra/seeds/seed.ts"
```

(First `railway ssh` run on a new machine needs an SSH key registered --
`railway ssh keys add` -- and `ssh.railway.com`'s host key accepted, e.g.
`ssh-keyscan ssh.railway.com >> ~/.ssh/known_hosts`, since there's no TTY to answer the
usual interactive prompt.)

## 4. Netlify: the frontend

```bash
npx netlify sites:create --name <your-site-name> --filter @crop/web
npx netlify env:set VITE_API_URL "https://<your-api>.up.railway.app"
```

`--filter @crop/web` is required non-interactively (this is a pnpm monorepo; Netlify's CLI
otherwise prompts to pick a workspace, which hangs with no TTY to answer it) -- but it also
makes the CLI auto-set this site's build `base` to `apps/web`, which then double-joins with
`netlify.toml`'s repo-root-relative `publish = "apps/web/dist"` into a nonexistent
`apps/web/apps/web/dist` if you let Netlify run the build itself (`netlify deploy --build`).
Simplest fix: build locally (exactly what CI/the dashboard path would do anyway) and deploy
the already-built folder directly:

```bash
VITE_API_URL="https://<your-api>.up.railway.app" pnpm turbo run build --filter=@crop/web...
npx netlify deploy --prod --dir apps/web/dist --site <site-id-from-sites:create> --filter @crop/web
```

**If the deployed site 401s for every visitor, including yourself in incognito**: check
whether your Netlify *team* has account-wide SSO/visitor access control enabled
(`npx netlify api getSite --data '{"site_id":"<id>"}'` -- look for `sso_login`/
`account_sso_login: true`). New sites inherit that team default, which is fine for
internal tools but defeats a demo meant for outside visitors. Override at the site level
without touching the team's other sites:

```bash
npx netlify api updateSite --data '{"site_id":"<id>", "body": {"sso_login": false}}'
```

## 5. Close the loop: point the API's CORS back at the real frontend URL

```bash
railway variables --service crop-api --set "CORS_ORIGIN=https://<your-site>.netlify.app"
railway variables --service crop-api --set "APP_PUBLIC_URL=https://<your-site>.netlify.app"
```

Setting a variable triggers an automatic redeploy -- `railway status` shows `Deploying` for
a few seconds, then back to `Online`. Without `CORS_ORIGIN`, the browser console shows CORS
errors and the Socket.io connection (HID/video) fails even though plain REST calls work.
`APP_PUBLIC_URL` is a separate variable from `CORS_ORIGIN`, even though they're the same
value here -- it's what password-reset links point at, not a CORS allowlist; see
`env.validation.ts`'s own comment on why they aren't the same setting.

## 5a. (Optional) Real password-reset emails via Resend

`MAILER_DRIVER` defaults to `file` -- the API still runs and the reset flow still works
without this step, it just writes emails to a file on the container's (ephemeral) disk
instead of actually sending them, same tradeoff as `SNAPSHOT_STORAGE_DIR` in "Known
limitations" below. To send real mail: create a [Resend](https://resend.com) account, verify
a sending domain, then:

```bash
railway variables --service crop-api --set "MAILER_DRIVER=resend"
railway variables --service crop-api --set "RESEND_API_KEY=<your Resend API key>"
railway variables --service crop-api --set "MAIL_FROM=RadLink <no-reply@your-verified-domain.com>"
```

## 6. Getting login codes for the demo

TOTP secrets aren't printed anywhere permanent -- `infra/scripts/totp-codes.ts` reads them
live from the database and computes a fresh code every time it's run. Same `railway ssh`
approach as seeding:

```bash
railway ssh -s crop-api -- pnpm exec tsx ../../infra/scripts/totp-codes.ts
```

## 7. Bootstrapping a superadmin on the deployed instance

Same `railway ssh` approach, same idempotency guarantee as running it locally -- safe to
run more than once, and safe to run alongside step 3's seed data (they don't interact):

```bash
railway ssh -s crop-api -- pnpm exec tsx ../../infra/seeds/bootstrap-superadmin.ts
```

Override the default email/password by exporting `SUPERADMIN_EMAIL`/`SUPERADMIN_PASSWORD`
in the same `ssh` command (`railway ssh -s crop-api -- sh -c "SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... pnpm exec tsx ..."`),
matching the pattern used for `SEED_PIKVM_HOST` in step 3.

## Known limitations of this deploy (all deliberate, all fine for a demo)

- **Real video never decodes.** The mock PiKVM sends fake, non-H.264 frame bytes to
  exercise the connection/framing protocol, not real video -- see its own docstring and
  `docs/architecture.md`. Everything else (HID input, takeover, print-text, the audit
  trail, the patient queue) works end to end -- verified with a real headless-browser login
  against the actual deployed URLs above, zero console errors.
- **Session snapshots don't survive a redeploy.** `SNAPSHOT_STORAGE_DIR` writes to local
  container disk; Railway wipes that on every redeploy/restart unless you attach a volume.
  Fine for a demo, not for anything meant to persist.
- **Chat attachments don't survive a redeploy either, for the identical reason.**
  `CHAT_ATTACHMENT_STORAGE_DIR` (default `./storage/chat-attachments`) is the exam-support
  chat's own local-disk store (see `ChatAttachmentStorageService`'s own docstring) -- same
  MVP tradeoff as `SNAPSHOT_STORAGE_DIR` above, same fix if it ever matters (attach a volume,
  or swap the storage port's implementation for object storage).
- **Password-reset emails, if `MAILER_DRIVER` is left at its `file` default, go to the same
  ephemeral container disk** (`MAIL_OUTBOX_PATH`) as session snapshots above, for the same
  reason -- fine for a demo (`railway ssh -s crop-api -- cat <MAIL_OUTBOX_PATH>` to read the
  latest link), but set up Resend (step 5a) for anything real.
- **One API instance, no horizontal scaling.** Socket.io's in-memory adapter (the default)
  only works correctly with exactly one instance -- scaling to multiple would need the
  Redis adapter wired in, which isn't done here (out of scope for a demo deploy).
