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
pnpm --filter @crop/api test:e2e  # tenant isolation, RBAC, session/WS-gateway lifecycle + takeover against real Postgres/Redis
```

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
