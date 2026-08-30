# Architecture

This document is the reference for the design decisions that source code comments point back
to throughout the codebase (`grep -rn "docs/architecture.md"` to find every call site).

## Resilience: one PiKVM's failure must never affect another tenant

`PiKvmHidClient` and `PiKvmMediaRelay` (`packages/pikvm`) are both Node `EventEmitter`s that
relay WebSocket connection errors as their own `'error'` event. `EventEmitter` throws --
crashing the entire process -- if `'error'` is emitted with zero listeners attached. In a
multi-tenant API holding one persistent connection per piece of equipment, that means one
offline or misconfigured PiKVM could take down every tenant's active session, not just its
own. This was caught by the Day 2 hardware spike (`infra/spike/pikvm-spike.ts`) run against
an unreachable host, not by code review -- see the README's Tests section.

Both classes are now safe-by-construction: their constructors attach a default logging
listener so the process can never crash regardless of whether a caller remembers to attach
its own, while still emitting `'error'` for callers (like `PiKvmConnectionRegistry`) that
want to react to it. The lesson generalizes: anything that opens a connection to hardware
this project doesn't control must assume that hardware will be unreachable at some point,
and must degrade (log, retry, mark the equipment `DEGRADED`) rather than crash.

## Trust boundary

The browser never talks to PiKVM directly, and never receives PiKVM credentials. The API is
the sole PiKVM client for every piece of equipment:

```
Browser --TLS--> API (NestJS) --WireGuard/Headscale--> PiKVM V4 --USB/HDMI--> Console
   |  Socket.io /rt      (session control, HID input, takeover, latency ping)
   |  raw ws  /stream    (binary H.264 relay, ticket-authenticated)
   +- WHEP <-- MediaMTX <-- RTSP <-- room camera
```

This is what makes two things possible at all:

- **Takeover is an enforced control, not a UI label.** `Session.controllerUserId` is checked
  on every input event before it reaches the device. If the browser could reach PiKVM
  directly, there would be nowhere to put that check -- PiKVM itself has no per-user
  permission model (see `docs/pikvm-integration.md`).
- **The audit trail is complete.** Every HID event, print, takeover, and session
  start/end passes through the API, so there is exactly one place that ever fails to log
  something: a bug in the API, not a browser that decided to skip the backend.

## Video: two independent paths, deliberately not sharing infrastructure

- **Console video** (PiKVM -> operator): a pure byte relay (`MediaStreamServer`,
  `PiKvmMediaRelay`) on a plain `ws` server, separate from Socket.io. See
  `docs/pikvm-integration.md` for why this is a relay and not a re-implementation, and why
  Socket.io isn't used for it.
- **CCTV room feed**: MediaMTX, RTSP in, WHEP out. 1-2s of latency is acceptable here per the
  original spec -- this path is explicitly allowed to transcode where the console path is not.

Mixing these would violate the latency budget: any transformation of the console video adds
processing time with no benefit, since the browser already speaks PiKVM's exact wire protocol
(see `stream_media.js` in PiKVM's own repo, which is what `apps/web/src/hooks/use-media-stream.ts`
re-implements against `/stream` instead of PiKVM directly).

## Two WebSocket servers, one HTTP server: a real multiplexing bug, not a hypothetical one

`MediaStreamServer` (raw `ws`, path `/stream`) and `SessionsGateway` (Socket.io, path `/rt`)
both need to handle WebSocket upgrades on the same HTTP server -- exactly the architecture
described above. The first implementation used `ws`'s own convenience constructor,
`new WebSocketServer({ server: httpServer, path: "/stream" })`, which seemed like the obvious
way to do this and typechecked, built, and passed every test that existed at the time.

It was broken. `ws`'s convenience constructor self-attaches an `'upgrade'` listener to the
*entire* HTTP server, unconditionally -- not filtered by path at attachment time. Every
upgrade request, including ones for `/rt`, fires it. Internally it checks the path and, on a
mismatch, calls `abortHandshake()`, which writes an HTTP 400 **directly onto the raw socket
and destroys it**. Node's `EventEmitter` invokes every registered `'upgrade'` listener for the
same event, so if Socket.io's own engine.io handler (registered separately, also on
`httpServer`) had *already* successfully upgraded that exact socket for `/rt` moments
earlier, `MediaStreamServer`'s listener would still fire right after, see a path that isn't
`/stream`, and destroy the socket Socket.io was already using -- corrupting its frame stream.

The client-side symptom was a `ws` (Node) error: `Invalid WebSocket frame: RSV1 must be
clear`. RSV1 is the bit WebSocket's `permessage-deflate` compression extension uses, so this
looked exactly like a compression-negotiation mismatch and cost real time chasing that theory
(disabling `perMessageDeflate` on both ends, which is still in place as a legitimate latency
optimization for a high-frequency low-payload channel, but did not fix anything) before the
actual mechanism -- two listeners fighting over one socket -- was found by reading `ws`'s own
source for `handleUpgrade`.

**No test caught this until the load test did**, and only because the load test was the
first thing to both (a) have `MediaStreamServer` active and (b) actually connect a real
Socket.io client -- every earlier e2e spec exercised REST endpoints exclusively. This was not
a load-test-only concern: it directly threatens the platform's core use case, an operator's
browser using the console video stream and sending HID input in the same session
simultaneously. Fixed with `ws`'s `{ noServer: true }` mode plus a single, manually-written
`'upgrade'` listener that checks the path itself *before* ever calling `handleUpgrade()`, and
returns without touching the socket at all on a mismatch -- the standard, documented pattern
for running `ws` alongside another WebSocket library on one HTTP server. Covered by a
permanent regression test (`test/websocket-gateway.e2e.spec.ts`) that connects a real
Socket.io client while `MediaStreamServer` is active; verified to actually fail against the
old code before confirming the fix.

The general lesson: a convenience constructor that "just works" in isolation can still be
unsafe to compose with a second instance of the same underlying pattern. Test the
composition, not just each piece alone.

## Latency budget

PiKVM V4 measures 35-50ms capture-to-render on a good connection (1080p60, H.264, `gop=0`,
boost on -- see PiKVM's own `/latency/` docs). Added on top for this platform's relay hop:

| Stage | Cost |
|---|---|
| PiKVM capture + encode + queue | ~30ms |
| PiKVM -> API (WireGuard/Headscale) | 10-40ms |
| API relay (pure byte pass-through, no re-encode) | 1-5ms |
| API -> browser | 20-60ms |
| Browser decode + display | 10-20ms |
| **Total** | **~70-155ms** |

Stays under the 200ms requirement with margin, on a LAN or a reasonable internet link. This
budget is the reason the video relay never transcodes and the HID gateway never blocks the
hot path on a network round trip (see "Two-tier audit" below).

## Deliberate MVP scope decisions (not oversights)

Two pieces of "should be Redis/distributed" infrastructure were built in-process instead,
with the port boundary already in place for a later move to Redis:

- **`SessionRuntimePort`** (`apps/api/src/modules/sessions/application/ports/session-runtime.port.ts`):
  the answer to "who currently controls this session" is an in-process `Map`, not Redis.
  At up to 60 input events/second per session, a Redis round trip on every single event
  would spend part of the latency budget on a value that only changes on takeover -- a rare,
  already latency-tolerant operation. This requires the gateway to run as a single process
  per PiKVM device; horizontally scaling later means moving this cache behind the same port
  to Redis with pub/sub invalidation, without touching any command handler.
- **`AuditFlushScheduler`**: drains the Redis input buffer on a plain `setInterval`, not
  `@nestjs/schedule`'s cron + a distributed lock. A second replica running this same job
  would double-flush; building lock infrastructure for a single-instance MVP deployment is
  exactly the kind of speculative generality that isn't worth the complexity yet.

Both are documented in their own source files, not just here, so a reader hits the
explanation at the exact place the decision was made.

## Two-tier audit

- **Critical events** (login, MFA, session start/end, takeover, blocked ATX/MSD attempts):
  written synchronously to Postgres before the request completes. These can never be lost.
- **High-frequency input** (up to 60 HID events/second per session): pushed to a Redis list,
  never awaited on the input path, and flushed every `AUDIT_FLUSH_INTERVAL_MS` (default 5s,
  not the 60s a naive design would use -- a Redis crash should lose seconds, not a minute, of
  audit history) into one Postgres row per session per flush window, batched per tenant in a
  single transaction.

Every row is hash-chained (`@crop/shared`'s `computeAuditHash`): each row's hash covers its
own payload plus the previous row's hash, per tenant. Altering or deleting a historical row
breaks every hash after it, and `VerifyAuditChainHandler` recomputes the whole chain to prove
it. Immutability itself is enforced by a Postgres trigger
(`prisma/migrations/*_audit_append_only`), not by application code or table
grants -- a trigger fires regardless of which role owns the table, which matters because this
MVP's single Postgres role both runs migrations and serves the app (REVOKE alone would not
stop the owning role). Production should still layer REVOKE UPDATE/DELETE via a separate
least-privileged app role on top of the trigger, as defense in depth.

## Multi-tenant isolation

Enforced at the query layer, not by a blanket guard: every query/command that loads a
tenant-scoped resource (equipment, sessions, audit logs) takes the caller's `tenantId` from
their JWT and either filters by it or asserts the loaded resource belongs to it
(`GetEquipmentHandler` is the clearest example). A resource that fails the check raises
`ForbiddenError`, not a 404 -- deliberately distinguishable in logs from "doesn't exist".

`GetSessionQuery` originally had no such check at all -- caught by the tenant-isolation e2e
spec, not by inspection, despite the exact same pattern already existing for equipment. The
lesson: this kind of check needs a test per resource type, because "we already do this
elsewhere" does not mean it was applied everywhere.

## Equipment exclusivity: one active session per piece of equipment

`PiKvmConnectionRegistry` holds one ref-counted connection per equipment, which implicitly
assumed only one session would ever reference a given equipment at a time -- but nothing
actually enforced that assumption before this phase. Two different operators could both
successfully `POST /sessions` against the same equipment, producing two independent Session
rows each believing itself to be in exclusive control, with `SessionRuntimePort` keyed by
session id rather than equipment id providing no coordination between them.

Fixed at both layers, deliberately:
- **Application-level check** (`StartSessionHandler`): fast path, friendly `ConflictError`
  for the common case of two sequential requests.
- **Database-level partial unique index** (`sessions_one_active_per_equipment`,
  `prisma/migrations/*_one_active_session_per_equipment`): the actual correctness guarantee.
  The application check alone has a TOCTOU race under true concurrency -- two requests could
  both pass "is anyone using this?" before either commits its `INSERT`. `Prisma`'s `P2002`
  unique-violation error is caught in `PrismaSessionRepository.create()` and translated back
  into the same `ConflictError`, so the API behaves identically whether the race is actually
  hit or not.

This is the general pattern for any "at most one X" invariant that matters: an application
check for good error messages, a database constraint for the actual guarantee.

## Every network call to hardware needs a timeout

`PiKvmRestClient`'s `fetch()` calls had none. An unreachable PiKVM meant `POST
/api/hid/reset` -- called by `PiKvmHidClient.releaseAll()`, the stuck-key safety mechanism
invoked on *every* session end, takeover, and disconnect -- would hang for however long the
OS's own TCP retry behaviour takes, which can be well over a minute. That is exactly the
safety-critical path that must be fast and bounded, not the one place latency doesn't matter.

Fixed with `AbortSignal.timeout(5000)` on every request. `EndSessionHandler` additionally had
a redundant *second* call to the same reset endpoint (`releaseAllInput()` immediately followed
by `release()`, which itself triggers a release via `PiKvmDevice.disconnect()`) that doubled
the real-world cost of this exact scenario; removed once the equipment-exclusivity work above
made it clear `release()` always actually disconnects for this project's session model.

Both were caught by an e2e test timing out against a deliberately unreachable fixture host
-- not by reading the code, which looked correct in isolation.

## e2e test infrastructure: two module-loading hazards worth knowing about

`apps/api/test/*.e2e.spec.ts` boots the real, compiled application and drives it over real
HTTP with `supertest` against a dedicated `crop_test` database. Getting there hit two
non-obvious failures, both worth documenting so nobody re-discovers them from scratch:

1. **A native addon crashed the whole Node process when Vitest transformed the app's TS
   source on the fly.** `argon2`'s N-API addon, loaded through Vitest/`vite-node`'s own
   module transform of `src/app.module.ts` and everything it imports, aborted the process
   with a raw V8-level crash (no catchable JS error) during `NestFactory.create()`. The
   identical bootstrap against the pre-built `dist/app.module.js` via plain `node` worked
   with no issue. Fix: `test/helpers.ts` imports from `../dist/`, not `../src/`, and
   `test:e2e` runs `nest build` first -- the same tradeoff `infra/seeds/seed.ts` already
   accepted for the same underlying reason.

2. **A "dual module instance" problem broke NestJS CQRS's handler lookup.** Even after
   switching to `dist/`, importing command classes (`RegisterUserCommand`, etc.) directly
   into a test file and dispatching them via `app.get(CommandBus).execute(...)` failed with
   "No handler found" -- `@CommandHandler(RegisterUserCommand)`'s metadata is attached to the
   *exact class object* Nest's own internal `require()` chain resolved when building the
   module graph, and Vitest's separate module cache for the test file's own direct import
   produced a different object despite it being "the same" file. The same problem broke
   `app.get(PrismaService)` for the identical reason. Fix: test fixture setup avoids the
   app's `CommandBus`/DI container entirely, using a standalone `PrismaClient` plus direct
   `argon2`/`otpauth` calls instead (see `test/helpers.ts`'s `createLoggedInUser`). The actual
   flows under test (login, MFA, every REST endpoint) still run through real HTTP via
   `supertest`, which never touches this hazard -- only *fixture construction* had to change.

## Auth hardening: rate limiting, logout, and refresh-token rotation

`LoginHandler` and `VerifyMfaHandler` both call through a `RATE_LIMITER` port
(`RedisRateLimiterService`) before doing anything else:

- **Login is keyed by email** (`ratelimit:login:${email}`), not by caller IP.  The threat is
  credential stuffing against one specific known clinical account, which an attacker can
  trivially spread across IPs but not across the one email they're targeting -- IP-based
  limiting would be reasonable defense-in-depth *in addition*, not a substitute. 10
  attempts / 15 minutes, and the counter increments on every attempt (right or wrong
  password), so guessing correctly on attempt 11 does not bypass a lockout that started on
  attempt 1-10.
- **MFA verification is keyed by `userId`** (`ratelimit:mfa:${userId}`, decoded straight out
  of the MFA-challenge token, before ever touching the database), not by the challenge token
  itself -- a fresh login always mints a new challenge token, so keying by token would let an
  attacker reset their own attempt budget just by re-logging-in with a password they already
  have. 10 attempts / 5 minutes: a 6-digit TOTP code (10^6 space) with a tolerated ±1 time-step
  window is brute-forceable without a limit here, and this is the only thing standing in the
  way once an attacker already has a valid password.
- Both use the same atomic INCR-then-conditionally-EXPIRE Lua script as the rationale
  documented inline in `redis-rate-limiter.service.ts` (a `MULTI`/`EXEC` cannot express
  "`EXPIRE` only if this was the first `INCR`", so a race could produce a key that lives
  forever -- a permanent lockout the first time it's ever hit).

**Logout and refresh-token revocation.** `AuditAction.LOGOUT` existed in the enum from the
start of the project but nothing ever dispatched it -- there was no revocation mechanism for
a logout to actually *do* anything against a stateless JWT, so it was pure decoration. Fixed
by:

- Every refresh token now carries a random `jti` (via `jsonwebtoken`'s `jwtid` sign option),
  generated at sign time, never supplied by a caller.
- `TokenRevocationPort` / `RedisTokenRevocationService` is a **denylist**, not an allowlist:
  it only ever needs to remember the rare case of an explicit revocation (logout, or a used
  token being rotated -- see below), not every token ever issued, because JWTs are validated
  by signature alone by default. Each revocation entry's Redis TTL is set to the token's own
  *remaining* lifetime (`claims.exp - now`), so a revoked entry disappears from Redis at
  exactly the moment the token would have stopped being valid anyway -- nothing accumulates
  forever.
- `POST /auth/logout` (`LogoutCommand`/`LogoutHandler`) verifies the refresh token, revokes
  its `jti`, and audits `LOGOUT`. An already-invalid/expired token makes this throw rather
  than silently succeed -- deliberate, because the frontend (`auth-context.tsx`) clears its
  local tokens regardless of this call's outcome, so there is nothing to gain from swallowing
  the error just to always return 204.
- `RefreshTokensHandler` now also **rotates**: after checking the presented token isn't
  already revoked, it mints a new access+refresh pair and then revokes the just-used refresh
  token's `jti`. A leaked-and-replayed old refresh token now fails with `401 UNAUTHORIZED`
  instead of silently working forever -- standard refresh-token-rotation practice, and cheap
  here since the revocation store already exists for logout.

## What's intentionally not built

- **ATX (power) and MSD (virtual USB) control**: not implemented in `@crop/pikvm` at all, not
  hidden behind a permission check. See `docs/pikvm-integration.md` for the clinical-safety
  and PHI-exfiltration reasoning.
- **Operator-tunable mouse sensitivity/scroll-rate sliders, CapsLock LED sync, the
  modifier-hold "magic shortcut" composer**: all present in PiKVM's own web UI, all skipped
  here as polish that doesn't affect correctness or safety, in the interest of the 30-day
  timeline.
