# CROP — Clinical Remote Operation Platform (MVP)

Multi-tenant platform for remote operation of clinical equipment (MRI/CT) via PiKVM, with
mandatory 2FA, enforced supervisor takeover, and a hash-chained append-only audit trail.

See [`docs/architecture.md`](docs/architecture.md) for the system design and the reasoning
behind its MVP-scope tradeoffs, and [`docs/pikvm-integration.md`](docs/pikvm-integration.md)
for the PiKVM wire protocol and every edge case (keyboard layouts, coordinate math, the
stuck-key safety mechanism) this integration depends on.

## Stack

- **API**: NestJS + TypeScript, Clean Architecture (`domain` / `application` / `infrastructure`
  / `presentation` per module) + CQRS (`@nestjs/cqrs`).
- **DB**: PostgreSQL 15 + Prisma, with a database-level trigger enforcing that `audit_logs`
  is append-only.
- **Cache/buffer**: Redis 7 (AOF), used for the high-frequency HID input buffer ahead of the
  audit flush.
- **Frontend**: React 19 + Vite + TypeScript.
- **PiKVM client**: `packages/pikvm`, a standalone package implementing PiKVM's verified HID
  and Direct-H.264 WebSocket protocols.
- **CCTV**: MediaMTX (RTSP in, WHEP out) — room camera feed only, never the console video.
- **Observability**: structured JSON logs (`pino`, request-correlated) and Prometheus metrics
  (`prom-client`) at `/metrics` — see "Observability and load testing" below.

## Repository layout

```
apps/api        NestJS backend
apps/web        React frontend
packages/shared Zod contracts, WS event names, keymaps, coordinate math, modifier remap, hash chain
packages/pikvm  PiKVM HID + media client (no framework dependency, unit-testable without hardware)
infra/          docker-compose services, MediaMTX config, seed script
docs/           architecture + PiKVM integration reference
```

## Running it locally

Infrastructure (Postgres, Redis, MediaMTX) runs in Docker; the API and frontend run natively
with Node for fast iteration and straightforward debugging during a live demo. This is a
deliberate choice, not a shortcut: containerizing a pnpm workspace with native dependencies
(`argon2`) correctly is real effort with real ways to get subtly wrong, and isn't worth the
risk for an MVP demo where nobody is deploying this to a fleet of machines yet. Production
would add API/web Dockerfiles behind the same Compose file.

### 1. Prerequisites

- Node.js 20+, pnpm (`npm install -g pnpm`)
- Docker (for Postgres/Redis/MediaMTX)
- A PiKVM V4 on your network — or leave `SEED_PIKVM_HOST` at its placeholder to seed data
  without a reachable device (equipment will just show `OFFLINE`, everything else works)

### 2. Install and start infrastructure

```bash
pnpm install
docker compose up -d postgres redis
```

Postgres listens on `5433` (not the default `5432`) to avoid colliding with another local
Postgres instance — see `docker-compose.yml`.

### 3. Verify your PiKVM before trusting anything built on top of it

```bash
SPIKE_PIKVM_HOST=https://<your-pikvm-ip> \
SPIKE_PIKVM_USER=admin \
SPIKE_PIKVM_PASSWORD=<your-pikvm-password> \
pnpm spike:run
```

Connects directly to your real PiKVM (bypassing the API entirely) and checks, in order:
`GET /api/info`, the HID WebSocket handshake and `hid_state` event shape, the HID reset
endpoint, and the Direct-H.264 media WebSocket handshake plus live frame arrival. Sends no
keyboard/mouse input by default — see the script's own header comment for
`SPIKE_SEND_TEST_KEY` if you want to verify actual input injection against a non-production
target. `pnpm spike:mock` runs a protocol-conformance test double
(`infra/spike/mock-pikvm-server.ts`) if you want to exercise the tool with no hardware at all.

If this fails against your device, stop here and fix it before continuing — every later step
assumes this passes.

### 4. Configure and migrate the API

```bash
cp apps/api/.env.example apps/api/.env
# generate real secrets for anything beyond a laptop demo:
#   openssl rand -hex 32       -> JWT_ACCESS_SECRET / JWT_REFRESH_SECRET
#   openssl rand -base64 32    -> CREDENTIALS_ENCRYPTION_KEY

pnpm --filter @crop/api exec prisma migrate deploy
```

### 5. Seed demo data

```bash
SEED_PIKVM_HOST=https://<your-pikvm-ip> \
SEED_PIKVM_USER=admin \
SEED_PIKVM_PASSWORD=<your-pikvm-password> \
pnpm db:seed
```

This dispatches the *real* `RegisterUserCommand` / `CreateEquipmentCommand` etc. through a
bootstrapped Nest application context — not raw SQL — so seeded accounts behave identically
to ones created through the UI. It prints each user's email, password, and TOTP secret:
**add those secrets to an authenticator app now**, you'll need live codes to log in.

### 6. Run the API and frontend

```bash
pnpm --filter @crop/api dev     # http://localhost:3000
```
```bash
cp apps/web/.env.example apps/web/.env
pnpm --filter @crop/web dev     # http://localhost:5173
```

### 7. (Optional) CCTV room feed

```bash
docker compose up -d mediamtx
ffmpeg -f avfoundation -i "0" -c:v libx264 -f rtsp rtsp://localhost:8554/cctv   # macOS webcam example
```

Set an equipment's `cameraUrl` to MediaMTX's WHEP playback endpoint for that path (e.g.
`http://localhost:8889/cctv/whep`) to enable the picture-in-picture room camera on
`SessionPage` — `SEED_MEDIAMTX_WHEP_URL` does this for MRI-01 when seeding. This is a fully
separate video path from the PiKVM console (WebRTC via MediaMTX vs. the raw WebSocket relay
in `docs/architecture.md`) and is allowed the 1-2s of latency the console path is not.

## Observability and load testing

```bash
curl http://localhost:3000/metrics   # Prometheus exposition format; unauthenticated -- see MetricsController
LOADTEST_SESSIONS=20 LOADTEST_DURATION_SECONDS=20 LOADTEST_EVENTS_PER_SECOND=60 pnpm loadtest:input
```

Logs are structured JSON (pretty-printed in `NODE_ENV=development`) via `pino`, with every
log line tagged with the originating request's correlation id
(`shared/infrastructure/logging/`). `/metrics` exposes, among the default Node.js process
metrics, the handful that actually matter for this platform's own claims:
`crop_hid_forward_duration_seconds` (this platform's own input-processing overhead, distinct
from the full browser-to-device round trip the client-side latency HUD measures),
`crop_sessions_active`, `crop_audit_flush_duration_seconds`/`_batch_sessions`, and
`crop_pikvm_connection_errors_total` (labelled per equipment).

`pnpm loadtest:input` (`infra/loadtest/input-pipeline.ts`) drives N concurrent sessions, each
over a real Socket.io connection, at a configurable input rate, against the real running API.
At 20 sessions × 60 events/sec sustained for 20s (1129 events/sec achieved), every one of the
23,432 events processed landed in the fastest histogram bucket (≤0.5ms), averaging under 1
microsecond of handler overhead — this platform's own processing is a negligible fraction of
the 200ms budget; what the budget actually has to accommodate is network and PiKVM's own
capture/encode pipeline (see `docs/architecture.md`'s latency budget breakdown).

This load test is also what caught the most serious bug found in this phase: running two
WebSocket servers (`MediaStreamServer` and the Socket.io gateway) on one HTTP server via a
convenience constructor that seemed correct, typechecked, and passed every prior test, but
actively corrupted connections under the platform's own core use case. Full story, including
why the initial symptom pointed entirely the wrong way, in `docs/architecture.md`.

## Tests

```bash
pnpm --filter @crop/shared test   # coordinate math, modifier remap, hash chain (incl. the tamper-detection case)
pnpm --filter @crop/pikvm test    # auth/TOTP building, stuck-key release tracking, no-crash-on-connection-error
pnpm --filter @crop/api test:e2e  # tenant isolation, RBAC, session/WS-gateway lifecycle, auth hardening + takeover against real Postgres/Redis
```

`.github/workflows/ci.yml` runs all of the above (typecheck, build, unit tests, e2e) on every
push/PR against real Postgres and Redis service containers on the same ports/credentials as
`docker-compose.yml` -- not mocked infrastructure, same tradeoff as the e2e suite itself.

`test:e2e` boots the real application (compiled, against a dedicated `crop_test` database it
creates and migrates itself) and drives it entirely through HTTP/WebSocket with `supertest`
and a real `socket.io-client` — no mocked repositories. It is what actually found most of the
bugs below; none of them were caught by code review or by the unit-test layer alone. Full
detail on each is in `docs/architecture.md`; summary:

| Bug | Found by | Impact |
|---|---|---|
| `PiKvmHidClient`/`PiKvmMediaRelay` crashed the whole Node process on an unhandled `'error'` event | Day 2 hardware spike (`pnpm spike:run`) against an unreachable host | One offline PiKVM would have taken every tenant's session down with it |
| `ScheduleModule.forRoot()` was never imported | Manually verifying equipment status after this phase's other fixes | `PiKvmHealthPoller`'s `@Cron` silently never ran; equipment status never reflected reality, in dev *and* production |
| `GET /sessions/:id` had no tenant check at all | Writing the tenant-isolation e2e spec | Any authenticated user, any tenant, could read any session's operator/supervisor/status by UUID |
| Login and MFA were never audited anywhere | Writing the audit-chain e2e spec | The audit trail's headline compliance claim ("every login is recorded") was false |
| `PiKvmRestClient`'s `fetch()` had no timeout | The concurrency-limit e2e test timing out against a fixture's unreachable host | An unreachable PiKVM could hang `POST /sessions/:id/end` — the stuck-key safety path — for as long as the OS's own TCP retry behaviour takes |
| No constraint stopped two sessions on the same equipment | Reasoning about a ref-counted connection registry while fixing the timeout above | Two operators could get independent, uncoordinated control of the same physical console |
| `EndSessionHandler`/`AbortIdleSessionHandler` each called the device reset endpoint twice | Same timeout investigation, once the redundancy became visible at scale | Doubled real-world latency on the stuck-key safety path against any slow/unreachable device |
| `MediaStreamServer`'s `ws.Server({server, path})` destroyed sockets Socket.io had already claimed | `pnpm loadtest:input`, the first test to have both video relay and a real Socket.io client active together | Corrupted the WebSocket connection under the platform's own core use case: video + HID input in the same browser session |
| `AuditAction.LOGOUT` was defined in the enum but never dispatched anywhere | Auth hardening pass, reviewing what a "logout" actually did | No server-side effect at all: a stolen refresh token stayed valid for its full 7-day life even after the legitimate user "logged out" |
| `GetUserByIdQuery` had no HTTP endpoint and, once given one, no tenant check | Wiring up admin lock/unlock/reset-password endpoints | Would have let one tenant's admin look up another tenant's user by UUID, the same class of bug `GET /sessions/:id` had |
| `pnpm dev`'s Vite dev server could not run the frontend in a real browser at all | Actually loading the app in headless Chromium (Playwright) instead of only `curl`/`supertest`/`vite build` | Every import from `@crop/shared` (a CJS package) failed in the browser with "does not provide an export named..." — the entire frontend was unusable via the documented `pnpm dev` workflow, silently, for the life of the project so far |
| Every page was missing landmark structure (`<main>`, a real `<h1>`), and every form input's `<label>` was an unassociated sibling, not linked via `htmlFor`/`id` | Running `axe-core` against the real, running app in headless Chromium, not a manual read-through | Screen reader users got no page-content landmark and no announced name for any login/MFA/text-entry field |
| Initial data loads on the dashboard, session, replay, and audit pages had no error handling — only a `finally` clearing the loading flag | Deliberately testing what a failed fetch does, once error handling became the focus of this phase | A network failure or 500 left pages stuck on "Loading..." forever, or silently rendered a misleading empty-state message instead of any error |
| **`ExecuteTakeoverHandler` had no tenant-isolation check at all** — the most serious bug found in this project | Writing the first-ever test for takeover, one of the platform's three headline features, which had zero test coverage before this phase | Any SUPERVISOR/admin in *any* tenant could take over *any other tenant's* active session by sessionId alone, silently reassigning control of someone else's live clinical equipment |
| `setController` was an unconditional write with no protection against two near-simultaneous takeover attempts | Reasoning about what "enforced" takeover actually guarantees, once tenant isolation was fixed and testing continued | The database and the in-memory controller cache (the actual authority for gating live input) could end up disagreeing about who was really in control |
| `AuditAction.TAKEOVER_REQUESTED` was defined in the enum but never emitted anywhere | Same review — the third of four now-fixed "defined but unwired" audit actions found across this project (`LOGOUT`, this one, plus `GetUserByIdQuery`'s missing endpoint) | Denied, failed, or race-losing takeover attempts left no audit trace at all — only successful ones were ever recorded |
| A supervisor who takes over a session they weren't already part of (the normal case) never got joined to the session's Socket.io room or had their input context set up | Manually verifying the new "return control" feature through two real, simultaneous browser sessions — an operator and a supervisor | The takeover succeeded completely at the database/audit level, but the supervisor's own UI never found out, and even if it had, their HID input would have gone nowhere |
| **The queue module had no tenant isolation on any of its three routes, and no role gate either** — worse than the takeover bug above | A systematic "defined but never wired" audit across the whole codebase, following the exact pattern that found every bug in this table | Any authenticated user, any role, any tenant, could create, list (patient names included), or transition another tenant's patient queue by ID alone |
| `PrintTextHandler` awaited PiKVM's REST call with no try/catch | Adding the print-text validation below surfaced it: a print attempt against a struggling device threw before ever reaching the audit dispatch | An attempted print action left no trace at all — not even a failure record — if the device was slow or unreachable |
| `AuditAction.PERMISSION_DENIED`/`EQUIPMENT_CREATED`/`EQUIPMENT_UPDATED`/`QUEUE_ENTRY_CREATED`/`QUEUE_ENTRY_UPDATED` were all defined but never emitted; `PrintTextRequestSchema` validated nothing; a shared, tested `verifyAuditChain` helper was reimplemented by hand instead of called | Same systematic audit | Denied-access attempts, equipment/queue state changes, and print-text input all had gaps in either validation or the audit trail |

Codebase cleanup pass added: the queue tenant-isolation fix above plus everything in the two
rows after it, a CORS-default drift between the HTTP server and the WebSocket gateway, a
keymap free-text field now validated against PiKVM's real supported list, an equipment
config option (`MouseMode.RELATIVE`) that looked selectable but had zero implementation
anywhere in the input pipeline (now rejected until it's actually built), and three genuinely
dead `AuditAction` values removed outright rather than forced into service — see
`docs/architecture.md` for the full list, including what was investigated and found clean.

Security-hardening pass added: Redis-backed rate limiting on login/MFA, real logout with
refresh-token revocation and rotation, and admin-only account lockout/forced password reset.
`pnpm audit` reviewed too: the only findings are in dev-only tooling or the Prisma CLI's
config loader, never on the running API's request path — see `docs/architecture.md`.

Frontend accessibility pass added: landmark/heading structure, label associations,
`:focus-visible` styling, live-region error/status announcements, and a responsive
single-column layout below 900px, verified with `axe-core` against a live browser — see
`docs/architecture.md` for the full list and the one deliberately-unfixed exception (the
console capture zone's inherent keyboard trap, shared by every browser-based remote-KVM tool).

Supervisor-takeover hardening pass added: the tenant-isolation and race-condition fixes
above, full audit-trail completeness for takeover attempts, and the first test coverage
takeover has ever had (`test/takeover.e2e.spec.ts`) — see `docs/architecture.md`.

Return-control-to-operator feature added: a supervisor/admin can hand control back to the
operator without ending the session (`test/return-control.e2e.spec.ts`), closing the gap the
takeover-hardening phase flagged. Verified through two real, simultaneously-connected
browser sessions (an operator and a supervisor, live WebSocket updates on both sides) — the
same technique that found the room-join bug in the row above.

## Demo script

0. **(Optional, for a photographable latency proof)** Open `http://localhost:5173/latency-clock`
   on the machine PiKVM is capturing (not the operator's machine). It's a public route,
   deliberately outside the authenticated app — see `LatencyClockPage`'s own docstring. A
   single screenshot showing this clock's true time next to the same moment visible in the
   operator's console feed is a measurement nobody has to take on trust.
1. **Login + mandatory 2FA** — log in as `operator@alpha.crop.health`, enter the TOTP code.
2. **Dashboard** — equipment list scoped to the operator's tenant, patient queue per machine.
3. **Start a session** — console view opens; the latency HUD shows measured input RTT, and
   the room camera PiP appears if `cameraUrl` is configured (step 7 above).
4. **Type a patient ID** — via the print-text field, not per-keystroke, so accented
   characters (`pt-br` keymap) render correctly.
5. **Takeover** — open a second browser as `supervisor@alpha.crop.health`, join the same
   session, click "Take over". The operator's window shows the takeover banner and its input
   stops working immediately.
5a. **Return control** — in the supervisor's window, click "Return control to operator".
    The operator's takeover banner disappears immediately and their input works again,
    without either browser ever ending the session.
6. **Emergency release** — click "Emergency release" in the session sidebar; confirm no key
   is left stuck on the target (this is the same safety mechanism that fires automatically on
   disconnect, takeover, and idle timeout — see `docs/pikvm-integration.md`).
7. **End the session**, then **View replay** — scrub through the captured snapshot timeline;
   nearby audit events (input batches, print actions) are listed alongside each frame.
8. Open **Audit log** — every action is listed with a hash. Click "Verify hash chain" —
   passes. Manually edit a row's `details` in Postgres, verify again — fails, loudly, at the
   exact sequence number that was tampered with.
9. **Idle timeout** — start a session and walk away; after `SESSION_IDLE_TIMEOUT_MS` (10
   minutes by default — lower it via env var for a live demo) it's automatically aborted and
   the equipment freed, visible as a `SESSION_ABORT` audit entry with `reason: idle_timeout`.
10. **Tenant isolation** — log in as `operator@beta.crop.health`: Clinica Alpha's equipment,
    sessions, and audit log are completely invisible.

## What's out of scope for this MVP

See "What's intentionally not built" in `docs/architecture.md`. In short: ATX power control
and virtual USB mass storage are not implemented at all (clinical-safety and PHI reasons,
not a permission toggle), and several PiKVM web-UI conveniences (mouse sensitivity sliders,
CapsLock LED sync, the modifier-hold shortcut composer) were left out as polish that doesn't
affect correctness or safety within a 30-day timeline.
