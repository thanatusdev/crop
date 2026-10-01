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

**This table is an estimate, never a measurement this codebase performs.** PiKVM V4's own
published number (35-50ms capture-to-render on a good connection, 1080p60, H.264, `gop=0`,
boost on -- see PiKVM's own `/latency/` docs) is combined with a hand-estimated cost for this
platform's relay hop, added on top:

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

This is *not* the same thing as the input-latency HUD's `latency:ping`/`latency:pong` number
(`RT_EVENTS.LATENCY_PING`/`LATENCY_PONG`, apps/api's `SessionsGateway` and apps/web's HUD): the
HUD measures a real, live Socket.io control-plane round trip -- client sends a timestamp,
server echoes it straight back, no PiKVM or video in between at all -- which the codebase
genuinely measures on every session. The table above is glass-to-glass *video* latency
(capture -> encode -> relay -> decode -> render), which nothing in this codebase instruments;
video frames carry no timestamp this platform controls end-to-end, and PiKVM's own capture
pipeline is opaque from the API's side. Treat the HUD number as ground truth for control-plane
RTT, and the table above as an architectural budget derived from PiKVM's documentation, not as
two measurements of the same thing.


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

## Account lockout and admin-forced password reset

There is no self-service "forgot password" or "register" HTTP endpoint anywhere in the app --
`RegisterUserCommand` has never had one; only the seed script calls it directly through the
`CommandBus`. User administration is therefore already an out-of-band, admin-driven activity,
so the lockout and password-reset features added in this phase follow that same shape instead
of introducing a parallel self-service flow (which would also need an SMTP/mailer dependency
that doesn't exist anywhere in this codebase):

- **`POST /users/:id/lock` / `POST /users/:id/unlock`** (`UsersController`, CLINIC_ADMIN /
  PLATFORM_ADMIN only, tenant-scoped the same way `EquipmentController` is -- each handler
  re-checks `belongsToTenant`, never trusting the controller alone). Sets/clears
  `User.lockedAt`. `LoginHandler` and `VerifyMfaHandler` both reject a locked account (the
  latter specifically to close the window where an admin locks an account *between* a
  password check and MFA completion); `RefreshTokensHandler` rejects it too.
- **Bounded-window tradeoff, not an oversight**: access tokens are verified by signature and
  expiry alone (`JwtAccessStrategy`), with no DB round trip -- that's deliberate, so a lock
  doesn't retroactively invalidate an access token minted before it. A locked user's existing
  session can keep working for up to `JWT_ACCESS_TTL_SECONDS` (15 minutes by default) after
  an admin locks them; only the next refresh or login is where it actually bites. Checking a
  Postgres flag on every authenticated request (including every HID input WebSocket message)
  to close that window entirely would cost far more than it buys for a control this rarely
  exercised; if instant revocation is ever required, `JWT_ACCESS_TTL_SECONDS` is the knob to
  turn down, not a new DB hit added to the hot path.
- **`POST /users/:id/reset-password`** (same role/tenant rules) hashes and sets a new
  password directly -- no email, no reset token, no expiring link to secure. It deliberately
  does *not* also lock the account or revoke existing refresh tokens (that's what
  `lock`/`unlock` are for; an admin responding to a suspected credential leak should call
  both, not rely on one endpoint to do everything).
  **Reversed below, in "Password policy, history, and forced rotation": once a forced-change
  flow existed for other reasons, refusing to revoke sessions here stopped being defensible
  and started being an inconsistency -- see that section for why.**
- `GetUserByIdQuery` existed before this phase too, also with no HTTP endpoint and, like
  `GetEquipmentQuery` originally, **no tenant check in its handler at all** -- the same
  "unwired code has an unnoticed bug" pattern documented elsewhere in this file. Fixed by
  giving it the one real caller it always should have had (`GET /users/:id`, used by an
  admin to check lock/MFA status before acting) and the same `belongsToTenant` check
  `GetEquipmentHandler` already had.
- `UserDto` (the shape `GET /users/:id` returns) deliberately excludes `passwordHash` and
  `mfaSecret` even though the `User` domain entity exposes both -- an admin's "manage users"
  view is not a raw row dump.

## Security headers, CORS, and dependency audit

- **Helmet + scoped CORS were already correctly configured** (`main.ts`): `helmet()` with
  defaults, `enableCors({ origin: CORS_ORIGIN, credentials: true })`. No changes needed there.
- **`Cross-Origin-Resource-Policy: same-origin`** (one of helmet's defaults) looked like it
  might block the frontend's cross-origin `fetch()` calls (frontend on `:5173`, API on
  `:3000` -- genuinely different origins) into reading blob responses (snapshot images via
  `useAuthenticatedImage`) or even plain JSON. It doesn't: CORP only blocks **`no-cors`**
  cross-origin loads (a bare `<img src>` with no `fetch`/CORS involved); a `fetch()` in the
  default `cors` mode against a server that already sends a matching
  `Access-Control-Allow-Origin` is unaffected. Verified empirically with a real headless
  Chromium instance (Playwright) making both a JSON and a blob-shaped cross-origin `fetch()`
  from `http://localhost:5173` to `http://localhost:3000` -- both succeeded, no
  `Cross-Origin-Resource-Policy`-related failures. Documented here specifically so nobody
  "fixes" this again on a hunch without checking first.
- **Session fixation / CSRF do not apply to this API's auth model.** There is no
  server-side session store and no cookie-based auth anywhere -- every authenticated request
  carries a bearer access token the browser must attach itself (`Authorization` header), and
  the one WS-auth exception (`MediaStreamTicketService`'s short-lived, 30-second ticket for
  the `/stream` upgrade, which browsers can't attach headers to) is minted server-side
  *after* full login, scoped to a specific already-authenticated `userId`+`sessionId`, not a
  pre-authentication value an attacker could plant and later hijack -- the two preconditions
  classic session fixation needs (a session identifier that exists before authentication, and
  ambient credentials like cookies a browser sends automatically) are both absent. CSRF is
  moot for the same reason: there is no ambient credential for a third-party site to ride
  along on.
- **Dependency audit** (`pnpm audit`): 6 advisories, all inside dev/build-only tooling
  (`vitest`/`vite`/`esbuild`, exercised only by the test runner's own dev server, which this
  project never starts) and one (`deepmerge-ts`, via `@prisma/config`) inside the Prisma CLI's
  config-file loader, never on the request path of the running API. `pnpm audit --prod`
  confirms exactly one finding (the same `deepmerge-ts` one) in the tree that actually ships;
  it's exploitable only by merging an attacker-controlled, deeply-nested `prisma.config.ts` --
  not a realistic threat model here, and there's no newer 6.x `prisma` release that pulls a
  patched version (`prisma@6.19.3` is already latest-6.x; the fix needs Prisma 7's
  driver-adapter pattern, rejected elsewhere in this doc for MVP simplicity). Accepted, not
  ignored: revisit when evaluating a Prisma 7 migration.

## A real browser had never actually loaded this app until this phase

Every previous milestone's verification -- e2e tests, load tests, manual smoke tests -- drove
the API directly (`supertest`, raw `curl`, a `socket.io-client`/`ws` script) or built the
frontend (`vite build`) without ever loading it in an actual browser. Doing exactly that with
a headless Chromium (Playwright) surfaced a real, previously-invisible bug:

**`pnpm dev`'s Vite dev server could not run the frontend at all.** `packages/shared` compiles
to CommonJS (its `package.json` has no `"type": "module"`, so `tsc`'s `NodeNext` output
defaults to CJS -- exactly what `apps/api`'s own CommonJS build wants via plain `require()`,
which is why nothing on the API side ever caught this). Vite's dev server normally
CJS→ESM-interops third-party CommonJS dependencies automatically during its esbuild-based
`optimizeDeps` pre-bundling step, but a pnpm workspace package resolved through a symlink
apparently doesn't reliably get swept into that automatic discovery -- it was instead served
raw through Vite's `/@fs/` filesystem passthrough, handing the browser literal
`exports.TargetOs = ...` CommonJS source to satisfy a native ESM `import { TargetOs } from
"@crop/shared"`. The browser's console error was blunt about it: *"The requested module...
does not provide an export named 'TargetOs'"* -- meaning `LoginPage` (and everything else
importing from `@crop/shared`) failed before rendering anything at all.

`vite build` (production) was never affected -- confirmed by inspecting the built bundle,
which already had `TargetOs` correctly inlined -- because Rollup's own CommonJS-interop
plugin, used only for the production build path, handles this correctly regardless of how
the dependency was resolved. Only the day-to-day `pnpm dev` workflow was broken, silently,
for the entire life of the project so far.

**Fix**: `apps/web/vite.config.ts` now explicitly lists `@crop/shared` in
`optimizeDeps.include`, forcing it through the same esbuild pre-bundling/interop path a normal
`node_modules` CJS dependency gets automatically. Verified by re-running the full
credentials→MFA→dashboard→sign-out flow through real Playwright-driven Chromium against
`pnpm dev`'s actual dev server (not a workaround script) -- confirming a correctly-rendered
dashboard, equipment card, and patient queue, and a real server-side-revoked logout.

If `@crop/pikvm` (also CJS, but consumed only by `apps/api`, never by the browser) ever
gains a browser-facing consumer, expect the identical failure mode and the identical fix.

## Frontend polish and accessibility

A real accessibility tool (`axe-core`, run against a live Playwright-driven Chromium, the
same technique that found the Vite dev-server bug above) found and confirmed the fix for
every issue below -- this wasn't a manual guess-and-check pass.

- **Every page was missing landmark structure entirely.** No `<main>` anywhere, and several
  pages had no `<h1>` at all (`DashboardPage`'s first heading was an `<h2>`; `AuditPage` had
  no heading whatsoever, just a bolded `<strong>` in the topbar). Fixed uniformly: each page's
  topbar is now a `<header>`, its content area a `<main>`, and each has exactly one `<h1>`
  (visually hidden on `SessionPage`/`SessionReplayPage`, where the equipment name is already
  visible in the header -- the hidden `h1` exists purely to give screen reader users the
  "start of page content" landmark they'd otherwise never get). Heading levels were also
  skipping (`h2` straight to `h4` on the dashboard) -- renumbered to a proper `h1 > h2 > h3`
  chain. `axe-core`'s `landmark-one-main`, `region`, `heading-order`, and `page-has-heading-one`
  rules all pass now, verified live, not just by eyeballing the JSX.
- **Every `<label>` on `LoginPage` was a sibling of its `<input>`, not associated with it** --
  no `htmlFor`/`id` pair, and no implicit association either (they weren't nested). A screen
  reader landing on any of the four login/MFA/enrollment inputs would announce no name at
  all. Fixed on every input across `LoginPage`, `SessionPage` (the "type text" field, which
  previously had no label at all, only a placeholder -- not a substitute), and
  `SessionReplayPage` (the snapshot scrubber `<input type="range">`, also unlabeled).
- **No visible keyboard-focus indicator anywhere**, including on `.console-box` -- a plain
  `tabIndex={0}` div with zero focus styling of its own. Added a global `:focus-visible`
  outline for every interactive element.
- **Initial data loads on `DashboardPage`, `SessionPage`, `SessionReplayPage`, and
  `AuditPage` had no error handling at all** -- only a `finally` to clear a loading flag, no
  `catch`. A network failure or an unexpected 500 left some pages stuck on "Loading..."
  forever (an unhandled promise rejection logged only to the console) and others silently
  rendered an empty-state message ("No equipment registered") indistinguishable from a
  tenant that genuinely has none. Every initial load now has a real error state, a
  screen-reader-announced (`role="alert"`) message, and (where retrying makes sense) a Retry
  button.
- `AuditPage`'s session-id links were `<a href="#" onClick={preventDefault...}>` -- a
  navigation-by-button dressed up as a hyperlink to nowhere. Replaced with a real `<button
  className="link-button">` (new utility class, styled to look identical).
- Added `role="alert"`/`role="status"`/`aria-live` to error banners, the takeover banner, and
  the CCTV connecting/error state, so screen readers announce these when they change instead
  of silently updating text a sighted user would have to be looking at the right moment to see.
- `.session-layout`'s side-by-side grid now collapses to a single column below 900px, and the
  topbar/equipment-row wrap instead of overflowing, so the dashboard and audit views are
  usable on a tablet-width screen. The console itself doesn't get a responsive treatment
  beyond that: it fundamentally needs a real pointer and physical keyboard (see below), so a
  phone-width layout for it wouldn't be a real capability, just a smaller broken one.
- **The console capture zone (`.console-box`) is an intentional, undocumented-until-now
  keyboard trap** -- `useHidInput` calls `preventDefault()` on every keydown/keyup while it
  has focus, including Tab and Escape, because those need to reach the remote equipment's own
  OS, not move focus around the browser page. This is not fixable without breaking the actual
  feature (every browser-based remote-KVM/VNC/RDP client has this exact same tension) --
  documented in a code comment on `SessionPage` instead of silently shipped, and a keyboard
  user can still leave via Shift+Tab from *outside* the box or by clicking any other control.
  Screen-reader operation of the remote equipment itself was never in scope for the same
  reason `LatencyClockPage` is: this is fundamentally a sighted-operator, pointer-and-keyboard
  tool, the same way MRI/CT console software itself is.

## Supervisor takeover hardening

Takeover had **zero test coverage** before this phase, despite being one of the platform's
three headline features (README: "mandatory 2FA, enforced supervisor takeover, and a
hash-chained append-only audit trail"). Writing the first tests for it (`test/takeover.e2e.spec.ts`)
found two real bugs, one of them serious.

- **`ExecuteTakeoverHandler` had no tenant-isolation check at all -- the most serious bug
  found in this project so far.** Every other cross-tenant read in this codebase (equipment,
  sessions, users) had this exact class of bug caught and fixed at some point (see this
  document's other entries); takeover was the one write path where it was never caught,
  because it was never tested. Unlike `HID_INPUT`/`PRINT_TEXT` (which only ever act on a
  `data.session` populated by a prior, tenant-checked `JOIN_SESSION`), the gateway dispatches
  `TAKEOVER_REQUEST` straight from a client-supplied `sessionId` with no equivalent check of
  its own -- and the handler trusted it completely. Concretely: any authenticated
  SUPERVISOR/CLINIC_ADMIN/PLATFORM_ADMIN, in *any* tenant, could take over *any other
  tenant's* active session purely by guessing or observing a session UUID -- reassigning
  control of someone else's live clinical equipment, silently (PiKVM itself has no
  per-tenant concept to reject it at the device side either). Fixed by adding the same
  `session.tenantId !== command.tenantId` check every other handler in this codebase already
  has, in `ExecuteTakeoverHandler` itself -- not just in the gateway, following this
  project's established defense-in-depth pattern of never trusting the transport layer alone.
- **`setController` was an unconditional write, with no protection against two
  near-simultaneous takeover attempts.** Both could read the same stale `controllerUserId`,
  both pass `assertCanBeTakenOverBy`, and both write -- whichever transaction committed last
  would "win" the database, while the other believed it had won too, and (worse) the
  in-memory `SessionRuntimePort` -- the actual authority for gating live input, per its own
  docstring -- could end up pointing at whichever one updated the runtime cache last,
  independently of which one the database ended up agreeing with. Fixed by turning
  `SessionRepositoryPort.setController` into a compare-and-swap: it now takes the
  previously-read `controllerUserId` as a required "only if this is still current" precondition
  and returns whether it actually applied (`PrismaSessionRepository` implements this with
  `updateMany`'s `where` clause and its `count`, not `update`, which has no way to express a
  conditional match on a non-unique column). A lost race now surfaces as a `409 Conflict`
  ("this session was just taken over by someone else"), and the runtime cache is only ever
  updated by whichever attempt actually won at the database. Proven two ways in the test
  suite: a real two-socket WebSocket race (timing-dependent, not guaranteed to actually
  interleave on every run, but the *outcome* invariant -- exactly one grant, never zero,
  never two -- is asserted regardless) and a direct, deterministic test of the underlying
  `updateMany` compare-and-swap itself.
- **Audit completeness**: `AuditAction.TAKEOVER_REQUESTED` was defined in the enum from the
  start of the project but never emitted anywhere -- the same "defined but unwired" pattern
  documented elsewhere in this file (`LOGOUT`, `GetUserByIdQuery`). Now emitted
  unconditionally, before any check runs, on every takeover attempt -- successful or not.
  `TAKEOVER_GRANTED` is still added only on success, so "a `TAKEOVER_REQUESTED` with no
  matching `TAKEOVER_GRANTED`" is now a real, queryable signal of a denied, failed, or
  race-losing attempt, not just of successful ones. Every `TAKEOVER_REQUESTED` row is
  attributed to the session's *real* tenant (`session.tenantId`), deliberately never the
  caller's own claimed tenant -- otherwise a cross-tenant attempt would be misattributed to
  the attacker's own tenant, invisible to the victim tenant's auditors, defeating the entire
  point of auditing the attempt at all.
- **Not built, deliberately flagged rather than silently skipped**: there is no way to hand
  control *back* to the original operator once a supervisor has taken over, other than
  ending the session entirely and having the operator start a new one. `ExecuteTakeoverCommand`
  always transfers control *to the caller*; there is no "transfer control to a specific,
  different userId" primitive at all, and `TAKEOVER_ALLOWED_ROLES` excludes OPERATOR, so the
  original operator cannot even take back their own session by calling the same command a
  second time. This is a real workflow gap (a supervisor intervening briefly, then handing
  back control, is a reasonable and probably expected clinical workflow) but is a new
  capability, not a hardening fix of existing behavior -- noted here as a recommended
  follow-up rather than built speculatively in this phase.

## Returning control to the operator

Built as its own command, `ReturnControlToOperatorCommand`/`Handler`, structured identically
to `ExecuteTakeoverHandler` (same order of operations, same tenant check, same CAS-protected
`setController`, same unconditional-`REQUESTED`-then-conditional-`GRANTED` audit pattern) --
see that handler's docstring, all of which applies here unchanged. The differences that
matter:

- It always targets `session.operatorId`, never the caller. There is no general "transfer
  control to any given user" primitive, deliberately: this is the one narrow capability that
  was actually missing, not an invitation to build arbitrary control handoff.
- **Any** SUPERVISOR/CLINIC_ADMIN/PLATFORM_ADMIN may call it, not only whoever currently holds
  control -- mirroring takeover's own permissiveness (any eligible role may take over, not
  just a specific designated one), and matching a real scenario: the supervisor who took
  over might have disconnected, and someone else should still be able to hand control back.
- The operator can never call this to reclaim their own session unilaterally (`OPERATOR` is
  excluded from the allowed-roles list, same as takeover) -- if they could, a takeover would
  be trivially reversible by the very person it was needed against.
- `supervisorId` is passed through unchanged during the CAS, not cleared: the session keeps
  its record of who was involved as supervisor even after they're no longer the one holding
  input, which is what keeps them a `Session.isParticipant()` (able to rejoin, view replay,
  take over again later) afterward.

**A real, previously-invisible bug found while building and manually verifying this
feature**: `onJoinSession` only populates a socket's `data.session` (required by every other
handler -- `onHidInput`, `onPrintText` both no-op silently without it) and joins it to the
session's Socket.io room *if the caller already passes `session.isParticipant()`*. A
supervisor taking over a session they were never part of before -- the normal case, since
becoming a participant is what taking over *does* -- fails that check on their initial
`JOIN_SESSION` (sent automatically on every session-page mount, before any takeover
attempt), and nothing ever retried it afterward. The practical effect: **a supervisor who
successfully took over could not actually send any HID input or receive the
`CONTROLLER_CHANGED`/`SESSION_STATE` confirmation of their own takeover** -- the takeover
succeeded completely at the database and audit-log level (confirmed both by the e2e suite
and by direct API checks), but the UI of the person who just took over never found out, and
even if it had, their keystrokes would have gone nowhere. This is a bug in the *original*
takeover feature, not something introduced by return-control -- it was never caught earlier
because takeover had no test coverage at all until the previous phase, and that phase's
tests (correctly, for what they were testing) drove the takeover command directly rather
than through two real, simultaneously-connected browser sessions. Found specifically by
manually verifying this feature end-to-end with two real Playwright-driven browser contexts
(one operator, one supervisor) -- the same technique that has now found three separate,
previously-invisible bugs across this project (the Vite dev-server CJS/ESM failure, the
missing takeover tenant check, and this one). Fixed by extracting a shared `joinRoom` helper
(equipment lookup + `data.session` populate + room join) out of `onJoinSession` and calling
it, unconditionally, for the acting socket at the end of both `onTakeoverRequest` and
`onReturnControlRequest` -- by definition, a command that just succeeded means the actor is
now a legitimate participant, whether or not they ever passed the join-time check.

## Codebase cleanup pass

A systematic audit for the same "defined but never wired" pattern documented repeatedly
elsewhere in this file (`LOGOUT`, the takeover tenant check, `GetUserByIdQuery`) -- every
`AuditAction` enum value, every Command/Query, every `@crop/shared` barrel export, every Port
method, every env var, checked against actual call sites rather than just definitions.

- **The single most serious finding in this entire project, worse than the takeover
  cross-tenant bug: the queue module had no tenant isolation anywhere at all, on any of its
  three routes, and no role restriction either.** `QueueController.create()`/`list()`/
  `updateStatus()` took an `equipmentId`/`queueEntryId` straight from the request with zero
  check that it belonged to the caller's own tenant -- and unlike takeover (SUPERVISOR/admin
  only), there wasn't even a role gate, so any authenticated user, any role, any tenant,
  could create, list (patient first names included), or transition another tenant's patient
  queue purely by guessing or observing an ID. This module had zero test coverage of any
  kind before this phase, which is exactly why it went unnoticed. Fixed identically to every
  other tenant-isolation fix in this codebase: `QueueEntry` gained a `tenantId` (derived
  through its equipment relation, same as `Session`) and a `belongsToTenant` check, enforced
  in all three handlers -- `CreateQueueEntryHandler`/`UpdateQueueStatusHandler` load the
  target equipment/entry and check it before writing; `ListQueueByEquipmentHandler` checks
  the equipment before listing. `AuditAction.QUEUE_ENTRY_CREATED`/`QUEUE_ENTRY_UPDATED`
  (defined since early on, never emitted) are wired in alongside the fix, deliberately
  excluding `patientFirstName` from `details` -- same PHI-out-of-audit-details reasoning as
  `PrintTextHandler`.
- **`AuditAction.PERMISSION_DENIED`** was defined but never emitted -- `RolesGuard` threw
  `ForbiddenError` on every role mismatch but never recorded it. Now audits every denial
  (method, path, required roles, actual role), synchronously, the same "critical event" tier
  as `LOGIN_FAILURE`. Required turning `RolesGuard.canActivate` async (Nest guards support
  returning `Promise<boolean>` natively) to inject `CommandBus`.
- **`AuditAction.EQUIPMENT_CREATED`/`EQUIPMENT_UPDATED`** were defined but never emitted.
  `EQUIPMENT_CREATED` was straightforward. `EQUIPMENT_UPDATED` needed care: `UpdateEquipmentStatusCommand`
  is dispatched by `PiKvmHealthPoller` every 10 seconds for every piece of equipment,
  unconditionally -- naively auditing every dispatch would flood the audit trail with a new
  row per device every 10 seconds, forever, forever drowning out every actually-meaningful
  event. `UpdateEquipmentStatusHandler` now reads the equipment's current status first and
  no-ops (skipping both the write and the audit) unless the status actually changed, so only
  genuine transitions (ONLINE -> OFFLINE, etc.) get recorded, `userId: null` since this is a
  system action, not a user one.
- **`PrintTextRequestSchema` existed in `@crop/shared` from early on but validated nothing** --
  `sessions.gateway.ts`'s `onPrintText` took an inline `{ text: string }` type with zero
  runtime check, unlike `HID_INPUT`, which already `.safeParse`s against `HidInputEventSchema`.
  The schema itself was also wrong for how the gateway actually uses this data (it required
  a redundant `sessionId` the client never sends, since the gateway already tracks that via
  `data.session` from `JOIN_SESSION`) -- fixed to just `{ text }`, with a length floor and
  ceiling, and wired into the handler via `.safeParse`, same pattern as HID input.
- **A related bug found while adding that validation, in `PrintTextHandler` itself**: the
  `pikvm.printText()` REST call was awaited with no try/catch. Unlike `sendKey`/`sendMouseMove`
  (fire-and-forget sends over an already-open HID WebSocket), a REST call *rejects*, not just
  delays, against an unreachable/struggling device -- and that rejection used to propagate
  straight out of the handler, skipping the audit dispatch entirely. An attempted print
  action against a device having a bad moment left no trace at all, not even a failure
  record. Fixed by catching the rejection, logging a warning, and auditing regardless, with
  a new `delivered: boolean` field in `details` so "attempted but not delivered" is now a
  real, visible distinction instead of silence.
- **`verifyAuditChain`, a tested helper in `@crop/shared`, was reimplemented by hand inside
  `VerifyAuditChainHandler`** instead of being called -- the two had drifted to disagree
  structurally (the handler's public result uses the real `seq` column; the shared helper
  returns an array index), reconciled by looking the broken row's `seq` up from its index
  rather than assuming the two numbers coincide.
- **`sessions.gateway.ts`'s CORS default (`"*"`) had silently drifted from `main.ts`'s
  (`http://localhost:5173`, sourced from `EnvSchema`'s own default)** -- both read
  `CORS_ORIGIN`, but the gateway can't use `ConfigService` at all (`@WebSocketGateway`'s
  options are evaluated at class-definition time, before Nest's DI container exists), so it
  was always going to need its own literal fallback. That fallback now matches the real
  default instead of silently being more permissive than the rest of the API.
- **`PIKVM_KEYMAPS`/`DEFAULT_KEYMAP` existed in `@crop/shared` (every layout PiKVM's HTTP API
  actually supports) but `keymap` was validated as `z.string()` -- any string at all**,
  including one PiKVM would reject or silently mishandle. `CreateEquipmentRequestSchema` now
  validates against the real list (`z.enum(PIKVM_KEYMAPS)`).
- **`MouseMode.RELATIVE` is selectable when creating equipment but has zero implementation
  anywhere in the actual input pipeline** -- `use-hid-input.ts` always captures and sends
  absolute coordinates regardless of what's configured, and the WS session-join context
  never even threads `mouseMode` through in the first place. This is a real half-built
  feature, not just an unused export, and building it properly (relative-delta capture,
  a WS payload shape for deltas, PiKVM's relative HID semantics end to end) is a genuine new
  feature, not a cleanup fix -- so instead of building it speculatively, equipment creation
  now rejects anything but `ABSOLUTE` (`z.literal(MouseMode.ABSOLUTE)`) until it's actually
  implemented, so an admin can no longer pick an option that silently does nothing. The enum
  value itself is kept (removing it would be a breaking schema/DB change for no benefit) and
  `EquipmentSchema` (the read/response side) still accepts either value, so any equipment
  already in the database keeps rendering correctly.
- **`isModifierCode`** (a `Set.has()` one-liner in `@crop/shared`) had zero callers anywhere,
  including internally -- not even its own test file referenced it. Removed outright; unlike
  the keymap list above, there was no real call site to wire it into.
- **Removed three genuinely dead `AuditAction` values** rather than force homes for them:
  `MFA_SUCCESS` (redundant with `LOGIN_SUCCESS` -- MFA is mandatory, so there is no
  meaningful "logged in" moment that isn't also "passed MFA"), and
  `BLOCKED_ATX_ATTEMPT`/`BLOCKED_MSD_ATTEMPT` (ATX/MSD control is never implemented at all,
  on purpose, so there is no code path that could structurally ever emit either one -- see
  "What's intentionally not built" below). All three were plain `String` columns in Postgres
  with zero historical rows using these values, so removing them was a pure type-level
  change with no migration needed.
- Added `LOG_LEVEL` to `EnvSchema` for documentation/consistency, even though (like
  `CORS_ORIGIN` inside `SessionsGateway`) `PinoLoggerService` can't actually read it through
  `ConfigService` -- that logger is deliberately constructed in `main.ts` before
  `NestFactory.create()` runs, which is before env validation ever executes.

**Investigated and found clean, no changes needed**: every Port interface's every method is
both implemented and called from at least one handler or scheduler; every page/component
under `apps/web/src` is reachable from `App.tsx`'s routes; no `TODO`/`FIXME`/`XXX`/`HACK`
comments exist anywhere in the codebase.

## Running a demo without real PiKVM hardware

`infra/spike/mock-pikvm-server.ts` (`pnpm spike:mock`) is a real HTTP+WebSocket server
speaking PiKVM's actual protocol -- built during the Day 2 hardware spike as a protocol-
conformance test double, but it works equally well as a stand-in for a live demo. Point
`SEED_PIKVM_HOST=http://localhost:8443` (plain HTTP, not HTTPS -- see the mock's own
docstring) at seed time and everything works end to end except real video: login/MFA,
equipment health-polling to ONLINE, starting/ending sessions, HID input forwarding, takeover,
return-control, emergency release, print-text, the patient queue, and the full audit trail
including hash-chain verification. The one thing that doesn't work is the video panel itself
-- the mock sends fake, non-H.264 frame bytes purely to exercise the connection/framing
protocol, so the browser's `VideoDecoder` correctly reports a decode error there. This is
the intended, by-design scope of that mock (see its own docstring: "NOT a full simulator").

Two real, previously-invisible bugs were found running exactly this demo, both fixed the
same session:

- **`infra/` scripts (`infra/seeds/seed.ts`, `infra/spike/*.ts`, `infra/loadtest/*.ts`) have
  zero typecheck coverage anywhere in this monorepo's toolchain.** They run via `tsx` against
  compiled `dist/` output with no `tsc` pass over the calling script itself, ever. This is
  precisely why a breaking `CreateEquipmentCommand`/`CreateQueueEntryCommand` constructor
  signature change (adding `tenantId`/`actingUserId`, see the codebase-cleanup section above)
  went completely unnoticed by `pnpm typecheck`/`pnpm build`/the full e2e suite, and only
  surfaced when `pnpm db:seed` was actually run. Fixed the immediate regression in `seed.ts`;
  closing the underlying coverage gap (a `tsconfig` covering `infra/`, wired into a turbo
  task) is a recommended follow-up, not yet done.
- **The "Type text" field silently clearing itself on submit, with zero success feedback,
  looked indistinguishable from doing nothing at all** -- especially paired with the mock
  video's permanently-black "connecting" panel, which gives no visual confirmation either.
  The action was actually always working correctly (confirmed via the `PRINT_TEXT` audit
  row, `delivered: true`); this was a pure UX gap, not a functional bug. `SessionPage` now
  shows a transient "✓ Sent to equipment" confirmation (`role="status"`, auto-dismissing
  after 2.5s) immediately after submit -- a best-effort "your click registered" signal, not
  proof of delivery (there's no ack on the underlying fire-and-forget socket emit; the real
  proof is still the audit row).

## A second, more serious bug found the same way: queue entries were effectively single-use, forever

`Session.queueEntryId` is `@unique` on the `sessions` table -- a queue entry maps to *at
most one session, ever*, not just one *active* one (contrast with
`sessions_one_active_per_equipment`, which is a genuinely *partial* index scoped to
active/pending rows only). That constraint is reasonable on its own -- a session is meant to
be the one-time historical record of one clinical exam for one queue entry -- but **nothing
anywhere in the session lifecycle ever moved a queue entry's status off `WAITING`** when a
session started, ended, or aborted against it. `DashboardPage`'s "next waiting patient"
picker (`item.queue.find(q => q.status === "WAITING")`) therefore kept re-selecting the
*same*, already-consumed queue entry on every subsequent "Start session" click for that
equipment -- which always collided with the old session's row on the unique constraint,
forever, regardless of whether that old session succeeded, was cleanly ended, or was
auto-aborted by the idle-timeout sweep.

Made worse by `PrismaSessionRepository.create()`'s error handling: it mapped *any* P2002 on
this table to "Equipment already has an active session" -- true of the equipment-exclusivity
index, completely false and actively misleading for this one. Debugging this live took
directly comparing curl (worked -- a fresh, never-used queue entry) against the browser
(consistently failed -- the dashboard's stale-picker always re-selected the same, already-
consumed one) to find the real cause; the error message alone pointed at entirely the wrong
subsystem.

Fixed with two changes:
1. `Session` gained a `queueEntryId` getter (it existed in the database, `create()`'s input,
   and audit `details`, but was never on the domain entity itself, so `EndSessionHandler`/
   `AbortIdleSessionHandler` had no way to know which queue entry a session they'd just
   loaded belonged to).
2. Each of the three lifecycle handlers now transitions the queue entry, best-effort
   (caught and logged, never allowed to fail the primary session operation): `StartSessionHandler`
   -> `IN_PROGRESS`, `EndSessionHandler` -> `DONE`, `AbortIdleSessionHandler` -> `CANCELLED`
   (deliberately *not* back to `WAITING` -- the unique constraint means this exact queue
   entry can never be attached to a new session regardless of status, so leaving it
   "WAITING" would misleadingly imply a retry is possible; the honest status is that this
   specific attempt didn't happen, and whoever coordinates the queue needs to add the
   patient again for a real retry).
3. `PrismaSessionRepository.create()`'s P2002 handling now inspects `err.meta.target` to
   distinguish which constraint was actually violated, so a queue-entry collision gets its
   own accurate error message instead of borrowing the equipment-exclusivity one.

Required wiring `QueueModule` to export `QUEUE_REPOSITORY` and adding it to `SessionsModule`'s
imports -- the two modules had no dependency relationship before this, by design (sessions
didn't need to know about the queue at all until now).

Covered by two new tests in `test/session-lifecycle.e2e.spec.ts`: the full
WAITING -> IN_PROGRESS -> DONE cycle plus a second session on the same equipment afterward
(the actual regression), and the abort/CANCELLED path is *not* independently covered by a
real idle-timeout-triggered test (that would mean actually waiting out
`SESSION_IDLE_TIMEOUT_MS`, which this suite deliberately never does) -- verified by code
inspection instead, since it's the identical `queue.updateStatus()` call pattern the other
two paths already prove works.

## The admin dashboard had no admin UI at all

Reported live: a CLINIC_ADMIN saw the exact same "Equipment" screen every other role sees --
no way to list or create users, no way to add equipment through the UI. The gap turned out
to be real and total, not a misunderstanding of some hidden setting.

**What was already there, unused**: `GET /users/:id`, `POST /users/:id/lock`,
`POST /users/:id/unlock`, `POST /users/:id/reset-password`, and `POST /equipment` were all
already fully implemented, CLINIC_ADMIN/PLATFORM_ADMIN-gated, and tenant-isolated (see
"Account lockout and admin-forced password reset" above) -- no frontend page had ever called
any of them. `DashboardPage.tsx` had exactly one role-conditional element in the whole app
(show/hide the "Audit log" button); the router had none at all. Strong evidence this was an
oversight rather than a deliberate cut: `packages/shared/src/contracts/users.ts` already had
a `UserSchema`/`UserDto` with a comment literally describing "what an admin's manage users
view is allowed to see" -- someone designed the data shape for this screen and it never got
built.

**A real, smaller gap found while closing that one**: there was no way to *list* a tenant's
users at all -- only `GET /users/:id`, a lookup by an ID you'd already have to know from
somewhere else. Lock/unlock/reset-password had nothing to point them at. Added
`UserRepositoryPort.findByTenant()` + `GET /users` (mirrors `EquipmentRepositoryPort.listByTenant`
exactly).

**User creation turned out much smaller than expected.** There is still no self-service
registration endpoint and still no mailer anywhere in this codebase (unchanged from the
reasoning above) -- but `LoginHandler` already re-derives a fresh `provisioningUri` from
whatever `mfaSecret` is already stored on the user row, every time someone with
`mfaEnabledAt: null` logs in, completely independent of how that row was created. So a new
`POST /users` endpoint just needs email/password/role; the *new user's own* first login,
against the *existing, unmodified* `LoginPage` enrollment flow, handles MFA setup with zero
new code. The admin relays the email/temp-password out of band (Slack, in person) exactly
like the seed script's console output always implied a human would, just from a button
instead of a terminal.

One deliberate restriction: `CreateUserRequestSchema`'s `role` field excludes
PLATFORM_ADMIN. `POST /users` always creates the account inside the *calling admin's own
tenant*, and a tenant-scoped platform admin is a contradiction in terms -- that role means
"operates across every tenant," not "operates within one clinic." The seed script follows
the same rule already (it never mints one either).

**Equipment creation and patient-queue management got UI too**, since they had the identical
shape of problem: `POST /equipment` and `POST /queue`/`POST /queue/:id/status` were already
fully implemented and already had zero frontend callers. Equipment creation became its own
admin-gated page (`/admin/equipment`); queue management (add a patient, cancel a WAITING
entry) landed directly on `DashboardPage`'s existing per-equipment queue table instead, open
to any authenticated role -- `QueueController` was never role-gated to admins in the first
place (an operator/receptionist workflow, not an admin one), so the UI shouldn't invent a
restriction the API never had.

**A second, independent bug found by finally giving `POST /queue/:id/status` its first-ever
caller from an actual browser**: it returned HTTP 201 with a completely empty body, instead
of 204 like every other "do a thing, return nothing" endpoint in this codebase (lock/unlock/
reset-password all correctly use `@HttpCode(HttpStatus.NO_CONTENT)`). The existing
supertest-based e2e coverage never caught this because `supertest`'s `.expect(201)` doesn't
care whether a body exists -- but a browser's `fetch` + `res.json()` throws outright on an
empty body with a 2xx-but-not-204 status, which is exactly what the new frontend code hit
immediately. Fixed by adding the same `@HttpCode(HttpStatus.NO_CONTENT)` the other endpoints
already use, and updating the one existing test asserting `.expect(201)` to `.expect(204)`
to match. A good reminder that "supertest says 2xx" and "a real browser can actually parse
the response" are not the same claim.

New e2e coverage: `test/admin-user-management.e2e.spec.ts` -- tenant-scoped listing with no
`passwordHash`/`mfaSecret` leakage, RBAC on both new routes, the PLATFORM_ADMIN-creation
rejection, and a full real-HTTP round trip proving a freshly admin-created user can log in
and complete MFA enrollment entirely on their own, with the admin never seeing a
provisioning URI or secret at any point.

## PLATFORM_ADMIN becomes a real superadmin, not just another name in a permission list

Requested directly: "create a superadmin, to manage tenants like companies and other
clinics." Investigating first turned up something worth stating plainly: **every single
occurrence of `PLATFORM_ADMIN` anywhere in this codebase, before this phase, just added it
to the same permission list as `CLINIC_ADMIN`.** No route, guard, or handler treated it as
architecturally distinct. No PLATFORM_ADMIN account had ever been seeded, tested, or created
through any path. `TenantType.PLATFORM` existed in the schema and shared enum as a dormant,
unused placeholder. This phase is what actually builds the thing the role's name always
implied.

**New `apps/api/src/modules/tenants/` module**, mirroring `equipment/`'s layout exactly:
`TenantRepositoryPort` + Prisma impl, `CreateTenantCommand`/`DeactivateTenantCommand`/
`ReactivateTenantCommand`, `ListTenantsQuery`, and `TenantsController` exposing
`POST /tenants`, `GET /tenants`, `POST /tenants/:id/deactivate`, `POST /tenants/:id/reactivate`
-- all `@Roles(PLATFORM_ADMIN)` **alone**, the first routes in this codebase not lumped with
CLINIC_ADMIN. No `belongsToTenant` check exists anywhere in this module, unlike every other
one: there is no "caller's own tenant" to scope against here, by design -- a PLATFORM_ADMIN
operates *above* any single tenant for exactly these four routes, and nowhere else (see
below on why this stops short of a cross-tenant "god view").

**Deactivation, never deletion.** A tenant gains one nullable `deactivatedAt` column, the
same shape as `User.lockedAt`. A real `DELETE` was considered and rejected: it would cascade
into deleting that tenant's `audit_logs` rows, directly contradicting the one thing this
platform's audit trail is built to guarantee -- append-only, immutable, enforced by a
database trigger regardless of which role touches it. Confirmed the hard way, not just in
theory: manually attempting to delete a leftover test tenant during verification hit
Postgres's own foreign-key constraint (`audit_logs_tenantId_fkey`, `RESTRICT` by default) --
the database itself refuses, independent of any application-level policy. Every other
"remove something" action in this codebase already avoided real deletion for the identical
reason (locking a user, aborting a session, cancelling a queue entry); this is the same
pattern, plus now direct proof it's load-bearing, not just cautious.

Deactivation has real teeth, not just a dashboard flag: `LoginHandler` and
`RefreshTokensHandler` both gained a tenant-deactivation check immediately alongside their
existing user-lock check, with the identical bounded-window tradeoff already documented for
locks (an access token issued before deactivation keeps working for at most
`JWT_ACCESS_TTL_SECONDS`; refresh and fresh logins are rejected immediately). Required
`IamModule` to import the new `TenantsModule` for `TENANT_REPOSITORY` -- the same
cross-module dependency shape `SessionsModule` already has on `QueueModule`.

**One safety guard worth calling out**: `DeactivateTenantHandler` refuses outright to
deactivate a `PLATFORM`-type tenant. Without this, a PLATFORM_ADMIN could deactivate their
own tenant and lock out every platform admin at once, including themselves -- with no
UI-reachable way back in, since reactivating requires being logged in as exactly the role
that action would have just disabled. Cheaper to refuse the action than to design a
break-glass recovery path for a self-inflicted problem.

**Cross-tenant user creation, narrowly.** `CreateUserRequestSchema` gained an optional
`tenantId`, honored by `UsersController.create()` *only* when the caller is PLATFORM_ADMIN
(bootstrapping a brand-new tenant's first CLINIC_ADMIN from outside it) -- silently ignored
for everyone else, who stay confined to their own tenant regardless of what they put in that
field. Explicitly tested that a CLINIC_ADMIN including this field is not a privilege-
escalation path. `POST /users` still refuses `PLATFORM_ADMIN` as a creatable role
unconditionally, even for a PLATFORM_ADMIN caller -- superadmin accounts stay
bootstrap-script-only, not proliferatable through a form.

**No cross-tenant "god view."** Deliberately scoped out: a PLATFORM_ADMIN's `GET /users`
still only returns their own (Platform Operations) tenant's users, same as everyone else --
confirmed live, not just by reading the code, via a real browser session showing the
superadmin's own user list stays a single row after creating a user in a different tenant
through the same page. Tenant lifecycle and cross-tenant provisioning are in scope; browsing
another tenant's equipment, sessions, or audit logs is not, and would touch every list/get
query in the codebase rather than staying confined to one new module.

**Bootstrapping the first superadmin**: deliberately has no HTTP endpoint at all --
`infra/seeds/bootstrap-superadmin.ts` (`make bootstrap-superadmin`), a standalone script in
the same "dispatch real commands through a real Nest app context" shape as `seed.ts`,
idempotent (a second run detects the existing `PLATFORM`-type tenant and no-ops rather than
creating a duplicate). Creating a god-mode account is a security surface an HTTP API
shouldn't carry at all, self-service or otherwise.

**Frontend**: `/superadmin/tenants` (list, create, deactivate/reactivate), gated by a new
`canManagePlatform` check distinct from the existing `canManageAdmin` (which correctly still
includes CLINIC_ADMIN for the user/equipment pages -- tenant lifecycle is the one thing a
CLINIC_ADMIN never gets). `AdminUsersPage`'s create-user form grows an optional tenant
picker, visible only to PLATFORM_ADMIN, populated from `GET /tenants` and excluding
`PLATFORM`-type tenants from the choices (creating a regular user inside the platform's own
home tenant would be a mistake, not a feature).

**A related, separate gap closed in the same pass**: `POST /users` (added last phase)
emitted no audit event at all, for any role -- found while wiring `TENANT_CREATED` for the
new module and noticing user creation had never had an equivalent. Added
`AuditAction.USER_CREATED`, emitted from `RegisterUserHandler` itself (not just the
controller) so seed-script-created accounts get the same audit trail as admin-created ones,
with `userId: null` for the acting admin when there wasn't a human one (the seed script,
`bootstrap-superadmin.ts`).

New e2e coverage: `test/superadmin-tenant-management.e2e.spec.ts` -- tenant create/list RBAC,
the PLATFORM-tenant deactivation guard, a deactivated tenant's users actually losing login
and refresh access (mirroring `account-lockout.e2e.spec.ts`'s exact structure) and regaining
it on reactivation, the cross-tenant user-creation path, the anti-escalation case (a
CLINIC_ADMIN's `tenantId` gets ignored), the PLATFORM_ADMIN-creation refusal holding even for
a PLATFORM_ADMIN caller, and all four new audit actions firing and attributed to the correct
tenant.

## Closing the backend<->frontend coverage gap: equipment lifecycle and live push

Requested directly: an audit of every backend route/WS event against what the frontend
actually calls, to find out what's missing. The audit (exhaustive -- every controller route,
every WS event, every command/query's dispatch sites, cross-referenced against every
`api.*`/`socket.*` call in `apps/web/src`) turned up two real gaps, both closed in this
phase, plus a couple of harmless dead ends left alone (see below).

**Equipment had create-only lifecycle, inconsistent with Users and Tenants.** Users got
lock/unlock; Tenants just got deactivate/reactivate (see above); Equipment had neither an
edit path nor a manual status override, on either end, since the MVP's first phase.
`EquipmentStatus.MAINTENANCE` had existed in the shared enum from day one as a pure,
never-set placeholder -- the same "defined but never wired" shape as several bugs found
earlier in this project, just never actually triggered because nothing ever *tried* to set
it.

- `EquipmentDto` gained `pikvmHost`/`pikvmUser` (not secrets -- an address and a login name,
  not a credential) specifically so an edit form has something to show/prefill; the password
  and PiKVM TOTP secret still never round-trip to a client, and never will.
- `PATCH /equipment/:id` (`UpdateEquipmentCommand`), every field optional, `pikvmPassword`
  absent/blank meaning "leave the stored credential unchanged" -- identical convention to
  `AdminResetPasswordRequestSchema`.
- `POST /equipment/:id/maintenance` / `.../maintenance/clear` (`EnterMaintenanceCommand`/
  `ClearMaintenanceCommand`), both of which delegate to the *existing*
  `UpdateEquipmentStatusCommand` (extended with an optional `actingUserId`, null for
  `PiKvmHealthPoller`'s own automatic transitions) rather than writing status directly --
  this is what makes the audit dispatch and the live-push broadcast below fire correctly for
  a manual toggle too, not just for poller-driven ones, with zero duplicated logic.
- `PiKvmHealthPoller.pollAll()` now filters out any equipment currently in `MAINTENANCE`
  before polling it at all. Without this, the very next cycle (at most 10s later) would
  silently revert a manual override, making the whole feature pointless. Clearing
  maintenance reverts to `OFFLINE`, not directly to `ONLINE` -- `ClearMaintenanceHandler` has
  no way to know the device's actual current reachability without a real health check, and
  guessing `ONLINE` would be a lie the poller's own next cycle (now unblocked) will correct
  either way within 10 seconds.
- Reused the existing `EQUIPMENT_UPDATED` audit action for edits and both maintenance
  transitions, distinguished by `details`, rather than minting three new enum values --
  matching how `UpdateEquipmentStatusHandler` already treated a poller-driven status change
  as an `EQUIPMENT_UPDATED` variant, not a separate action.
- `AdminEquipmentPage` gained an actual equipment list (it was create-only, no list at all)
  with per-row Edit and Enter/Clear-maintenance actions, mirroring `AdminUsersPage`'s
  create-form-plus-list-with-actions shape. One new CSS badge variant (`.badge.maintenance`)
  alongside the existing online/offline/degraded three.

**`RT_EVENTS.QUEUE_UPDATED`/`EQUIPMENT_STATUS_CHANGED` existed as constants from the start,
emitted and listened for by nothing.** Without them, two simultaneous dashboards only ever
saw each other's queue changes or an equipment status flip after a manual reload -- correct
data, just never *live*.

The interesting part was avoiding a real module cycle: `SessionsModule` already imports
`QueueModule` (for `StartSessionHandler`/`EndSessionHandler`'s queue-status transitions), so
having `QueueModule`/`EquipmentModule` call directly into `SessionsGateway` (which lives in
`SessionsModule`) to broadcast would need the import running the other way too -- a genuine
cycle. Fixed by using the *other* half of `@nestjs/cqrs`, which this codebase had only ever
used for Commands/Queries until now: `CreateQueueEntryHandler`/`UpdateQueueStatusHandler`/
`UpdateEquipmentStatusHandler` publish a plain `QueueUpdatedEvent`/`EquipmentStatusChangedEvent`
via `EventBus`, and two new `@EventsHandler` classes living inside `SessionsModule` (where
`SessionsGateway` already is, so no new import needed there) react and call two new public
broadcast methods on the gateway. CQRS event handlers are discovered globally regardless of
which module declares them, so `QueueModule`/`EquipmentModule` have no idea anything is
listening -- fully decoupled, no cycle.

Broadcasts are tenant-scoped: `SessionsGateway.handleConnection` now auto-joins every socket
to a `tenant:${tenantId}` room the moment it authenticates (the JWT/tenantId is already
verified right there), so a broadcast can never reach a different tenant's clients -- tested
explicitly, not just assumed. `DashboardPage` (which previously opened no WebSocket
connection at all) now opens one via the existing `createSessionSocket()` helper (not
actually session-specific despite the name) purely to listen for these two events, reacting
by re-running its existing `load()` re-fetch -- the simplest correct reaction, consistent
with how it already reloads after every local action.

**Left alone, on purpose:** `GET /users/:id` is real and tenant-scoped correctly, but the
frontend only ever needed the list endpoint -- not a gap, just an unused-by-the-UI route.
`RT_EVENTS.ERROR` is emitted by the gateway (a non-participant's `JOIN_SESSION` attempt) but
never listened for client-side -- a real small gap, but session access is already gated by
the REST layer before a client would normally reach this path at all, so it's a rare edge
case rather than a functional problem; left as a known minor gap rather than folded into this
already-broad pass.

New e2e coverage: `test/equipment-lifecycle.e2e.spec.ts` (edit/maintenance RBAC and tenant
isolation, the password-blank-means-unchanged behavior verified directly against the stored
ciphertext, idempotency both directions, and that a session can't be started against
`MAINTENANCE` equipment) and `test/realtime-push.e2e.spec.ts` (a real Socket.io client
receiving both new events over a real WebSocket connection, plus the tenant-isolation
negative case -- a different tenant's connected socket never receives it). The
poller-actually-skips-maintenance-equipment behavior itself is verified by code inspection
only, not an automated test: exercising it for real would mean waiting out a full
`EVERY_10_SECONDS` cron cycle inside the e2e suite, the same category of tradeoff already
made (and already documented) for `AbortIdleSessionHandler`'s idle-timeout path.

## A verification pass: several README/docs claims had never actually been proven

Requested directly, after the README's Features section (see above) was written and
reviewed: go back through every specific claim in that section and in this document and
check, for each one, whether it's actually backed by a repeatable automated test or only by
inspection/prose/a one-off manual check. The investigation (read-only, via a dedicated
exploration pass) found four real gaps and one genuine documentation error; all five are
closed in this phase.

**Security headers/CORS were correctly configured, but no test had ever asserted the actual
response headers -- and the e2e test harness itself didn't even apply them.** `main.ts`'s
`bootstrap()` called `app.use(helmet())`/`app.enableCors(...)` directly on the Express
instance, imperatively, after `NestFactory.create()` -- not something `AppModule`'s own
providers can express. `test/helpers.ts`'s `createTestApp()` only ever did
`NestFactory.create(AppModule).init()`, never `main.ts`'s `bootstrap()` -- meaning every e2e
test in this whole suite, from day one, ran against an "app" that actually differed from the
real deployed one in exactly this respect. Writing `test/security-headers.e2e.spec.ts` against
`createTestApp()` as it stood failed both of its assertions (`undefined` headers), which is
what surfaced this. Fixed by extracting the security-relevant middleware into a shared
`configureApp(app)` (`src/configure-app.ts`), called by both `main.ts`'s `bootstrap()` and
`createTestApp()`, so the two paths can never drift apart again. The new spec's exact
assertions were derived from a live `curl` against the real running local demo API, not
guessed: every `helmet()` default header, plus confirmation that `Access-Control-Allow-Origin`
always echoes the fixed configured origin and never reflects an arbitrary request's `Origin`
header (tested with both a matching and a mismatched `Origin`).

**The two-tier audit trail's hash-chain algorithm and event *coverage* were well-tested; its
*timing* behavior never was.** A regression that made HID input synchronous (defeating the
whole point of buffering -- see `ProcessHidInputHandler`'s docstring on the 60-events/sec hot
path) or that broke the flush cron entirely would have passed every existing test.
`test/audit-two-tier-timing.e2e.spec.ts` proves both halves against a real running app: a
critical event (`LOGIN_FAILURE`, deliberately PiKVM-free so nothing here is confounded with an
unrelated network timeout) is queryable with zero wait between the triggering request and the
query; a real `HID_INPUT` sent over a real Socket.io connection is *not* present at all
immediately afterward, and only appears as one `INPUT_BATCH` row once
`AUDIT_FLUSH_INTERVAL_MS` (default 5000ms) has elapsed -- the same ~5.5s wait convention
already used elsewhere in this suite for flush-adjacent timing.

**`PiKvmMediaRelay` had the identical crash-safety pattern as `PiKvmHidClient`, but zero test
coverage of its own.** `packages/pikvm/tests/media-relay.test.ts` mirrors
`hid-client.test.ts`'s existing `FakeWebSocket`/crash-safety test exactly (constructs the real
client, calls `.connect()` with no external `'error'` listener attached, asserts emitting an
`'error'` event doesn't crash the process), plus two small connect/disconnect sanity checks
that file didn't have a direct analogue for.

**Nothing had ever proven that one tenant's PiKVM failure can't stall or corrupt a different
tenant's concurrently running session.** `PiKvmConnectionRegistry` keeps one entry per
`equipmentId` in a single in-process `Map`, shared across every tenant's sessions in one API
instance -- structurally sound by inspection (see "Resilience" above), but the only prior
evidence of actual cross-tenant isolation was a one-off manual hardware spike, once, by hand.
`test/cross-tenant-pikvm-isolation.e2e.spec.ts` sets up two tenants, each with its own
equipment and session, and exploits a real, already-existing block: `EndSessionHandler` awaits
`PiKvmGatewayPort.release()`, which itself awaits a real HTTP round trip to the device --
against this suite's standard unreachable fixture host, that stalls the *HTTP response* for
~5s. The test fires tenant A's session-end *without awaiting it*, then drives tenant B's
entire independent HID-input-buffer-flush cycle *while A is still mid-stall*, and only then
awaits A's response -- proving the two are not serialized on any shared lock, not just that B
"eventually" still works once A finishes.

**The ~70-155ms glass-to-glass video latency table and the input-latency HUD's measured
round-trip time were being described as if they were the same number.** They aren't: the HUD
(`latency:ping`/`latency:pong`) is a real, live Socket.io control-plane echo that never
touches PiKVM or video at all; the table is PiKVM's own published capture/encode number plus a
hand-estimated relay-hop cost, never measured by this codebase. README.md and this document's
own "Latency budget" section conflated the two in places (e.g. describing HID input forwarding
itself as bound by the video table's capture/encode/decode stages). Fixed as a documentation-only
change -- no new measurement instrumentation was added, per an explicit decision that building
one wasn't worth it for this phase; the `/latency-clock` proof page remains the one way to
actually check the estimated table against reality.

**apps/web had zero automated tests of any kind -- accessibility fixes made earlier in this
project's history were provable only by manual/AI-driven Playwright sessions, never by
anything a future regression would actually fail.** Added a real, local/on-demand test tier
(`apps/web/playwright.config.ts`, `apps/web/tests/a11y/`, `pnpm --filter @crop/web test:a11y`)
using `@axe-core/playwright` against the real running app, logged in through the real
mandatory-2FA flow (TOTP codes generated live from the seeded `mfaSecret`, read directly from
Postgres -- the same technique `infra/scripts/totp-codes.ts` uses, deliberately duplicated in
`tests/a11y/helpers.ts` rather than importing across the apps/web/apps/api package boundary).
Deliberately **not** wired into `.github/workflows/ci.yml`: it needs the full no-hardware demo
stack running, not just a package-local dependency install, and an axe-core scan is a
point-in-time DOM check, not something worth gating every commit on. `playwright.config.ts`'s
`webServer` runs `make demo` with `reuseExistingServer: true`, so it transparently reuses an
already-running demo stack (the normal case for a developer who's been working locally) or
starts one from scratch.

This tier immediately found a real, previously-unnoticed WCAG 2 AA violation, not a false
positive: `.btn.danger`/`.takeover-banner`'s white-on-`#d9463c` red was 4.29:1 contrast,
just under the 4.5:1 minimum for normal-weight text. Fixed by darkening to `#c23a30` (5.33:1),
same hue, both call sites. Two of this test tier's own early failures were the tier's own bugs,
not app bugs, and are worth recording as a caution for anyone extending it: an out-of-range
mouse-move fixture coordinate (`MouseMoveEventSchema` caps at ±32767, PiKVM's absolute HID
space) that the gateway's schema check silently dropped before it ever reached the audit
buffer; and a client-side route transition (`waitForURL` resolving before the outgoing page
component actually unmounts) that let an axe scan briefly run against the *previous* page's
still-mounted heading instead of the new page's own loading state.

## A supervisor who only watches a session (never takes over) used to get stuck forever when it ended

Reported directly by a user exercising the real app, not found by any test: a supervisor
opens an operator's active session to look -- via `DashboardPage`'s "Rejoin session," shown
for any active session regardless of who's viewing it, not gated to participants or even to
takeover-eligible roles -- without ever clicking "Take over." The operator later ends the
session from their own side. The supervisor's screen never updates: no redirect, and their
own "End session" button silently did nothing either.

Root cause: `SessionsGateway.onJoinSession` gated room membership on `Session.isParticipant()`,
which is only ever true for the operator or a supervisor who has *already* taken over --
never true for a supervisor merely watching. Their `JOIN_SESSION` was silently rejected (a
`RT_EVENTS.ERROR` was emitted, but the frontend never listened for it), so their socket never
joined `room(sessionId)` and never received `SESSION_ENDED`/`CONTROLLER_CHANGED`/
`SESSION_STATE` for the rest of the session's lifetime. Separately, `EndSessionHandler`
correctly requires `isParticipant` too, so their own "End session" click also failed --
compounding the stuck feeling with a second dead button, previously rendered unconditionally
regardless of whether it could ever succeed for the current viewer.

Fixed on both sides:
- `SessionsGateway.onJoinSession` now also admits any takeover-eligible role (`SUPERVISOR`/
  `CLINIC_ADMIN`/`PLATFORM_ADMIN` -- the same `VIEW_ALLOWED_ROLES` set `ExecuteTakeoverHandler`/
  `ReturnControlToOperatorHandler` already use for the takeover/return-control decision
  itself), not only actual participants. This is a *view* gate only: `onHidInput`/
  `onPrintText` still separately and unconditionally require holding control, so a mere
  viewer still cannot act on the equipment merely by having joined the room.
- `SessionPage.tsx`'s "End session" button now only renders for an actual participant
  (mirroring `Session.isParticipant()` client-side: `session.operatorId === user.sub ||
  session.supervisorId === user.sub`), so a viewing supervisor no longer sees a button that
  was always going to fail.

New coverage: `test/session-viewer-join.e2e.spec.ts` -- a supervisor who never took over
successfully joins and receives a real `SESSION_ENDED` once the operator ends the session
(reverting the gateway fix while writing this test reproduced the exact reported symptom,
confirming the test actually catches the regression); the same widened join still never lets
that supervisor's `HID_INPUT` reach the device, since they're never the controller; and an
unrelated `OPERATOR` in the same tenant (a role outside `VIEW_ALLOWED_ROLES`, not this
session's own) is still correctly rejected, proving the fix didn't over-widen the gate.
Verified live end-to-end against the running local demo, two real logged-in browser contexts,
in addition to the e2e suite.

## RadLink rebrand, a nine-role model, and the first role<->tenant-type invariant

CROP is now presented as **RadLink** on every user-visible surface (login screen, dashboard
topbar, `<title>`, the API's boot log). Internal identifiers -- `@crop/*` package names, the
Postgres database, `crop.accessToken`/`crop.refreshToken` localStorage keys, the
`@*.crop.health` seed email domain -- were deliberately left alone: renaming the localStorage
keys would silently log out every existing session for zero user-visible benefit, and the
rest are either infrastructure identifiers or values baked into real deployed resources (see
DEPLOY.md's live `crop-demo-frontend.netlify.app`/`crop-api-production-*.up.railway.app`
URLs), not something a login-screen task should be touching. The one genuine behavioral
split this causes: the TOTP issuer string changed from `"CROP"` to `"RadLink"`
(`otpauth-mfa.service.ts`), but `verifyCode` builds its TOTP from the stored secret alone, so
this is purely cosmetic -- already-enrolled users just keep seeing "CROP" in their
authenticator app, since the issuer is baked into the entry at scan time.

`UserRole` grew from five members to nine, to support a second, clinic-side family of roles
alongside the existing operator-side ones:

```
PLATFORM_ADMIN                                       (PLATFORM tenant)
CLINIC_ADMIN, LOCAL_SUPERVISOR, NURSING, LOCAL_IT     (CLINIC tenants)
OPERATOR_ADMIN, OPERATIONAL_SUPERVISOR, OPERATOR      (CLINIC or OPERATOR_PROVIDER tenants)
AUDITOR                                               (CLINIC or OPERATOR_PROVIDER tenants)
```

`SUPERVISOR` was renamed to `OPERATIONAL_SUPERVISOR` (a hand-written migration,
`ALTER TYPE "UserRole" RENAME VALUE`, not a Prisma-generated one -- Prisma's diff engine has
no concept of renaming an enum value; given the same before/after `schema.prisma` it would
have emitted a destructive type recreate instead) once the clinic side got its own, distinct
`LOCAL_SUPERVISOR` -- keeping one bare `SUPERVISOR` once there were two kinds of supervisor
would have been ambiguous about which side of the business a given user's permissions came
from. The rename carries every existing supervisor row, and every hardcoded permission array
that said `UserRole.SUPERVISOR` (`VIEW_ALLOWED_ROLES`, `TAKEOVER_ALLOWED_ROLES`,
`RETURN_CONTROL_ALLOWED_ROLES`, `AuditController`'s `@Roles`), over automatically.

**The first role<->tenant-type invariant** now exists (`packages/shared/src/roles.ts`'s
`ROLE_TENANT_TYPES`, enforced in `RegisterUserHandler`): until this, nothing in the codebase
validated a user's role against their tenant's `type` at all -- `TenantType.OPERATOR_PROVIDER`
was a dormant, unused placeholder (see the superadmin-phase section above). The obvious-looking
first design -- clinic roles CLINIC-only, operator roles OPERATOR_PROVIDER-only -- turned out
to be wrong, caught empirically by trying to seed the existing demo data against it, not by
review: `Equipment`/`Session` are still single-tenant-scoped everywhere
(`GetEquipmentHandler.belongsToTenant`, `StartSessionHandler`'s `GetEquipmentQuery` call)-- there
is no cross-tenant "an operator company remotely runs a different clinic's equipment" wiring
anywhere in this codebase. `operator@alpha.crop.health` has always been, and still is, a
member of the *Clinica Alpha* tenant, not of some separate operator-provider tenant --
that's the only way it's ever been possible for an operator to actually run a session against
that clinic's equipment. Restricting `OPERATOR`/`OPERATIONAL_SUPERVISOR`/`OPERATOR_ADMIN` to
`OPERATOR_PROVIDER` tenants only would have silently 403'd every existing operator and
supervisor account the moment `RegisterUserHandler` enforced it. The actual rule: those three
roles (plus `AUDITOR`) are valid in *either* `CLINIC` or `OPERATOR_PROVIDER` tenants;
`CLINIC_ADMIN`/`LOCAL_SUPERVISOR`/`NURSING`/`LOCAL_IT` are `CLINIC`-only;
`PLATFORM_ADMIN` is `PLATFORM`-only. `OPERATOR_PROVIDER` remains available
(`CreateTenantRequestSchema` now accepts it, seeded once as "Operadora Central") as a
standalone staff directory for an operating company -- it just doesn't have any equipment of
its own to run sessions against yet. Making that real (an operator company's staff running a
*different* tenant's equipment) is a separate, larger piece of cross-tenant work, not
attempted here.

> **Superseded.** The rule described in the two paragraphs above -- operator-side roles valid
> in *either* tenant type -- was reversed later. See **"Reversing the role model: operators
> belong to the operating company"** near the end of this document for what replaced it, why
> the original pragmatic reading stopped holding once the business model was pinned down, and
> how the "separate, larger piece of cross-tenant work" named in the previous sentence was
> actually done. The paragraphs are left as written: they record why the first answer was
> reasonable at the time, which is the more useful thing to keep.

Three previously fail-open routes were also closed as part of adding the new roles: `/queue`
(all three routes) and `POST /sessions` had no `@Roles` at all, so the new clinic-staff roles
would otherwise have inherited default access to patient-queue management and remote-session
control simply by being able to authenticate. `/queue` is now scoped to every role that
already used it via `DashboardPage`'s shared queue UI (`PLATFORM_ADMIN`, `CLINIC_ADMIN`,
`OPERATOR`, `OPERATIONAL_SUPERVISOR`, `OPERATOR_ADMIN`, `AUDITOR`) plus the new
`LOCAL_SUPERVISOR`/`NURSING` -- deliberately excluding only `LOCAL_IT`, which has no
legitimate reason to read or write patient identities. `POST /sessions` (starting a session)
is now `OPERATOR`/`OPERATIONAL_SUPERVISOR`/`OPERATOR_ADMIN`/`PLATFORM_ADMIN` only, at the
method level, not the controller level: `/end`/`/release-all` deliberately keep relying on
their existing `isParticipant` domain check rather than gaining the same role allowlist,
since `CLINIC_ADMIN` can become a session's controller via takeover
(`TAKEOVER_ALLOWED_ROLES`) and must still be able to end or release-all a session it took
over -- a role-gating that narrow would have been a real regression, caught by re-reading
`EndSessionHandler` before writing the change, not by a failing test.

## A pt-BR, role-redirecting login screen, built on top of an auth engine that didn't change

The 3-step login flow itself (credentials -> mandatory TOTP -> first-login enrollment) and
the entire auth engine behind it (argon2id, JWT purposes, Redis rate limiting, account
lockout) are untouched -- this phase is presentation, i18n, and the role-routing layer on
top, not a rewrite of `LoginHandler`/`VerifyMfaHandler`.

**Two steps, not one, despite the reference design showing a single screen.** The design
this phase was built from puts email, password, and the 6-digit code on one screen with one
submit button. The backend is a strict two-request flow (`POST /auth/login` returns an
`mfaToken`; a *separate* `POST /auth/mfa/verify` call, with a different token, actually mints
the session), and the two ways to reconcile that -- collapsing to one visible step by
chaining both requests behind a single submit, or keeping today's two-step shape -- were
each real tradeoffs, not a clear win either way: chaining both requests risks a wrong
password silently discarding an already-typed still-valid TOTP code, and risks a slow first
request straddling the 30-second TOTP window. The two-step shape was kept, restyled to match
the reference design's visual language (logo, card, field order, the shield/security
footer) without adopting its single-screen layout.

**Role-based redirect.** Every role previously landed on `/` unconditionally
(`LoginPage.tsx` hardcoded `navigate("/")`). `lib/role-routes.ts`'s `homeRouteForRole` now
sends the three new clinic-staff roles (`LOCAL_SUPERVISOR`/`NURSING`/`LOCAL_IT`) to a new
`/clinica` stub -- deliberately a stub, not a built-out page: there is no `Patient` model
anywhere in this codebase (the entire patient surface is one `patientFirstName` string on
`QueueEntry`, which has no `tenantId` column and whose repository only supports
`listByEquipment`), so a real clinic-side patient/queue UI for these roles is greenfield
work, not something to fake here. `CLINIC_ADMIN` deliberately stays on `/`: it already has
working admin surfaces there (`/admin/users`, `/admin/equipment`), and moving it would
regress a working page with nothing to replace it. `App.tsx`'s new `RoleRoute` wrapper also
closes a client-side (not authorization -- the API's own `@Roles` already rejected these)
UX gap: `/admin/*`, `/superadmin/tenants`, and `/clinica` were previously reachable by any
authenticated role, landing them on a page shell that would immediately 403 on every fetch.

**i18n**: `react-i18next`, pt-BR only, no language detector -- introduced because the login
and new recovery screens are the first pages moved off this codebase's until-now-universal
hardcoded English, not because a second real language exists yet. Module-augmenting
`CustomTypeOptions` against the one locale file means a typo'd translation key fails `tsc`,
not silently renders its own key name at runtime. Scoped to two namespaces (`auth`,
`recovery`) plus a not-yet-used `common` -- every other page stays English until it gets its
own pass; translating just the role `<select>` on `AdminUsersPage` in isolation would have
left that one page speaking two languages at once, which is worse than leaving it English a
while longer.

**Theme**: `styles.css` gained a `:root` custom-property layer holding exactly today's
existing dark values (zero visual change anywhere), plus a `.theme-light` scope with the
reference design's palette, applied only to `LoginPage`/`RecoveryPage`. Every light-theme
color was checked against WCAG AA's 4.5:1 via axe-core's own contrast calculation, not hand
math -- an initial `#0b7a90` accent measured at 4.44:1 against the page background, just
under the threshold, and was darkened to `#0a6f83` (~5.2-5.8:1 depending on background) after
the accessibility test tier actually caught it.

**Recovery screen** (`/recuperar-senha`) started as static instructions, no form, no backend
call, matching the "no self-service reset" decision documented in "Account lockout and
admin-forced password reset" above. That decision has since reversed -- see the section
below, added once this codebase actually had a mailer to build a real flow on top of. The
link now goes somewhere real instead of nowhere.

## Password reset via email, and the mailer this codebase never had before now

Reverses "Account lockout and admin-forced password reset" (above) and
`AdminResetPasswordHandler`'s own docstring, both of which called no-self-service-reset
deliberate specifically *because* building one meant adding this codebase's first mailer
dependency. That tradeoff changed, not the underlying judgment: a real product need for
users to recover their own accounts by email outweighs the added surface, now that adding a
mailer is the actual task rather than a side effect of a smaller one.

**Two new commands, mirroring the shape of the existing auth flow rather than inventing a
new one.** `RequestPasswordResetHandler` (`POST /auth/password-reset/request`) signs a
purpose-scoped JWT (`purpose: "password_reset"`, 15 min default TTL) -- the same pattern
`signMfaEnrollment`/`signMfaChallenge` already established, on the same access secret, with
one addition: a real `jti`, which neither MFA token needs, because this one has to be
denylistable after a single redemption (`TokenRevocationPort` gained a `kind` parameter,
`"refresh" | "password_reset"`, so the two families of revoked tokens never share Redis
key space, even though `jti`s are random UUIDs and would never actually collide).
`ResetPasswordHandler` (`POST /auth/password-reset/confirm`) redeems it: verify, check the
denylist, re-check lock/tenant-deactivation (an admin could act in the window between the
email going out and the link being clicked), hash, write, deny the `jti`.

**The response to `/password-reset/request` is identical whether or not the email belongs
to a real account** -- same email-enumeration reasoning `LoginHandler` already documents for
its own unknown-email case, applied to a form that (unlike login) is reachable by anyone,
logged in or not, typing anything. Concretely: the rate-limit check runs and can reject
*before* the account lookup, so a 429 leaks nothing about existence either; an unknown
email, a locked account, and a deactivated tenant all silently no-op behind the same "200,
did nothing" response; and the actual `mailer.send()` call is fired but never awaited
(`.catch`-handled so a failure becomes a log line, not an unhandled rejection) --
awaiting it would make response time depend on whether a real send happened, which is
itself a timing side-channel. `PASSWORD_RESET_REQUESTED` is only audited when a real user
was found, for the same "no tenantId to attribute it to otherwise" reason `LOGIN_FAILURE`
already documents.

**Sessions are revoked on a successful reset, closing a gap that would otherwise exist**: a
new `User.sessionsRevokedAt` column (additive migration, no data backfill needed) is set
alongside the password hash. At the time this was written, `UserRepositoryPort` gained a
`resetPassword()` method distinct from the pre-existing `updatePasswordHash` specifically so
`AdminResetPasswordHandler` -- which still called the old one -- could keep its own
documented behavior of NOT revoking sessions, the two paths deliberately not unified.
**That split didn't survive the next phase**: see "Password policy, history, and forced
rotation" below for why both paths now go through one `setPassword()` method and both do
revoke sessions. `RefreshTokensHandler` gained a third bounded-window re-check
alongside its existing lock/tenant-deactivation ones: a refresh token's `iat` predating
`sessionsRevokedAt` is rejected. This is a real security property, not just bookkeeping --
without it, resetting a password because a credential leaked would do nothing to a session
an attacker already holds.

**`MailerPort`** (`shared/infrastructure/mail/`) has two adapters: `ResendMailer` for
production, and `FileOutboxMailer` -- the actual default (`MAILER_DRIVER=file`) -- which
appends every message to `MAIL_OUTBOX_PATH` as JSON lines instead of sending anything. This
isn't a mock swapped in for tests; it's what `make demo` runs with too, so the whole flow is
usable end-to-end (open the file, copy the link) with zero external account. The Resend
adapter is constructed by hand inside `MailModule`'s factory, not registered as its own
Nest provider -- its constructor calls `config.getOrThrow("RESEND_API_KEY")`, and Nest
instantiates every registered provider eagerly at boot regardless of whether the app ever
asks for it; registering it directly would have broken every `MAILER_DRIVER=file` boot
(every dev machine, the entire e2e/a11y suite) for a key none of them set.

**`APP_PUBLIC_URL` is a new, deliberately separate variable from `CORS_ORIGIN`**, even
though they hold the same value in every environment this repo actually runs in today: one
is a security policy (who may call the API from a browser), the other is a link-building
base (where the frontend lives, for constructing the URL inside a reset email). Conflating
them would break the moment they diverge, which is exactly the kind of bug that's invisible
until a deploy where it isn't true anymore.

**The e2e suite exercises the real `FileOutboxMailer`, not a stub**: `test/helpers.ts`'s
`readLatestMailTo`/`extractResetToken` read the same JSON-lines file the running app wrote
to, through a path fixed in `setup-env.ts` (`MAIL_OUTBOX_PATH=./storage/mail-outbox.test.jsonl`,
separate from the dev default so a `make demo` running alongside `pnpm test:e2e` can't race
on the same file). This tests the actual email template rendering
(`password-reset-email.ts`), not just the handler logic that calls it.

**A real gotcha, found while verifying this feature by hand, not by a failing test**:
`make demo-reset` only ever reset Postgres, never Redis. Rate-limit counters and revoked-
token denylists live in Redis and are keyed by email/user id with real TTLs -- they don't
care that the underlying account was just deleted and recreated by a database reset. Running
the a11y suite's Recovery-page test repeatedly against the same fixed fixture email
(`a11y-recovery@test.crop.health`) silently burned through its 5-per-hour request limit
across several manual `make demo-reset` cycles in the same afternoon, and the *symptom* was
misleading: not a clear 429, but the frontend's modal simply never appearing and Playwright
timing out 60 seconds later waiting for a dialog that was never going to show up, because
the click handler's error path sets an error message instead of opening it. Fixed by having
`demo-reset` also `redis-cli FLUSHDB` -- a demo reset should mean a demo reset, not "reset
the parts that happen to live in Postgres."

## Password policy, history, and forced rotation

Four things arrived together because they all write to the same place: a shared strength
function used identically by client and server, a history table that blocks reuse, an
expiry clock that eventually forces a change, and a rewrite of every password-writing path
in the app to funnel through one transaction instead of several slightly-different ones.

**One policy function, not two.** `packages/shared/src/password-policy.ts` exports
`evaluatePassword(password, { email, firstName, lastName })`, imported unmodified by both
`StrongPasswordSchema` (server-side zod refinement, used everywhere a password is *set*: register,
self-service reset, admin reset, forced change) and every password-entry React component
(`PasswordStrength`, `PasswordPolicyChecklist`, the create-user form). This is deliberate,
not just convenient: a rule that only exists in one place would eventually drift, and a
password an admin's UI shows as "all requirements met" that the API then 400s on is a worse
experience than any individual rule choice. The policy itself: minimum 8 characters, upper +
lower + digit + symbol, and a "no personal info" check that scans the password (lowercased)
for first name, last name, brand tokens (`radlink`, `crop`), and every email local-part
token of 3+ characters containing at least one letter (so `a`, `12`, and other noise tokens
from an address like `j.doe+test@x.com` don't produce false positives, but `doe` or `jdoe`
would). Ten-plus characters is *advisory only* -- surfaced in the UI as a recommendation, a
`PASSWORD_RECOMMENDED_LENGTH` constant the checklist can render distinctly from the blocking
rules, but never something `evaluate(...).ok` treats as failing. `LoginRequestSchema.password`
deliberately stays a bare `min(8)`, never upgraded to `StrongPasswordSchema`: strengthening a
*login* schema doesn't strengthen any stored credential, it just turns an existing weak
password into a 400 instead of the enumeration-safe 401 `LoginHandler` already returns for
wrong passwords, and would lock out every account created before this phase shipped.

**The personal-info check runs unconditionally, including for rows with no name on file.**
`firstName`/`lastName` are new nullable columns (migration `20260928090000`, no backfill --
inventing plausible-looking names for historical rows would be worse than leaving them null)
so `evaluatePassword` treats `firstName`/`lastName` as optional and always has the email
local-part fallback to fall back on; the check is never skipped just because a name is
missing. New accounts create with required names (`CreateUserRequestSchema`) going forward,
so the null case only exists for rows that predate this migration.

**One write path for every password change.** `UserRepositoryPort.setPassword(userId, hash,
{ mustChangePassword })` replaces the `updatePasswordHash`/`resetPassword` split the previous
phase left behind (see the two callouts above) with a single transaction: update
`passwordHash` + `passwordChangedAt` + `sessionsRevokedAt` (always set to now, unconditionally
-- every password change revokes every existing session, no exceptions) + `mustChangePassword`,
insert a `PasswordHistory` row, prune history down to `PASSWORD_HISTORY_DEPTH` (5). Every
caller -- self-service reset confirm, the new forced in-band change, and admin reset -- goes
through this one method now. `AdminResetPasswordHandler` reverses its own prior documented
behavior as a direct consequence: it now also revokes sessions and sets
`mustChangePassword: true`. That's not a change of opinion so much as the old reasoning
("no session-revocation because that's what lock/unlock are for") no longer applying once
setting `mustChangePassword` needed the same write anyway -- doing it in the same transaction
that already revokes sessions is simpler than doing it in a third, different way. Password
reuse is checked before that write, not inside it: `assertPasswordNotReused` hashes the
candidate against `recentPasswordHashes(userId)` (the current hash plus up to
`PASSWORD_HISTORY_DEPTH` history rows) and throws `PasswordReuseError` (mapped to a 400 with
code `PASSWORD_REUSED`) on any match, so a user can't "reset" back to a password they just
had. `sessionsRevokedAt` and `passwordChangedAt` remain two separate columns even though
every current code path sets them together -- one is a revocation watermark
(`RefreshTokensHandler` checks a token's `iat` against it), the other a credential-age clock
(`User.isPasswordExpired` checks it against `PASSWORD_MAX_AGE_DAYS`) -- because they answer
different questions and a future feature (an admin revoking sessions *without* forcing a
password change, say) would need them to diverge.

**Expiry is enforced after MFA, not at the password-check step in `LoginHandler`.**
`User.passwordChangeReason` returns `"admin_reset" | "expired" | null`, and only
`VerifyMfaHandler` reads it, after MFA has already succeeded, before minting real tokens.
Checking it earlier -- inside `LoginHandler`, right after the password matches -- would leak
whether the password was actually correct to someone who doesn't hold the TOTP device: a
"you must change your password" response only reachable via a correct password is itself a
correct-password oracle for an attacker with a stolen password but no MFA device. Putting
the check on the far side of MFA closes that. `VerifyMfaCommand`/`VerifyMfaResult` became a
discriminated union as a result -- `{ status: "ok", ...tokens }` for the normal case,
`{ status: "password_change_required", changeToken, reason }` for the forced case -- and the
frontend's `LoginPage.handleMfaSubmit` branches on it, navigating to `/trocar-senha` with the
change token carried in React Router *state*, not a query param or localStorage. State-only
is deliberate: a reload loses it and bounces to `/login`, which is the correct behavior for a
credential-bearing token that should never survive in browser history, a URL bar, or
persisted storage the way a bookmark or back-button navigation would resurrect it.

**The change token is its own JWT purpose, `password_change`,** signed by
`TokenServicePort.signPasswordChange` / verified by `verifyPasswordChange`, TTL from
`PASSWORD_CHANGE_TTL_SECONDS` (600s default) -- the same "purpose-scoped JWT on the existing
access secret" shape `password_reset` and the MFA tokens already established, with its own
`RevocationKind` (`"password_change"`) so it denylists into its own Redis key space and
can't be confused with a refresh or password-reset token even though `jti`s are random and
would never actually collide. `ChangePasswordHandler` (`POST /auth/password-change`) redeems
it: verify, check denylist, re-check lock/tenant-deactivation (the same reasoning
`ResetPasswordHandler` documents -- state can change in the window between mint and
redemption), run the same policy + reuse checks, write via `setPassword`, deny the `jti`,
then mint a *real* session directly. That last part matters for the product, not just the
code: the user doesn't get bounced back to `/login` and forced through password + MFA again
after just proving both -- the whole point of putting the check after MFA is that MFA
already happened.

**`GET /auth/password-reset/validate`** exists so the rich reset screen (stepper, identity
card, live countdown -- see below) can render *before* the user submits anything. It's
read-only and, unlike `ResetPasswordHandler`'s confirm step, never denies the `jti`: checking
validity should not itself consume a single-use token, or opening the link (which every
mail client's link-preview/scanning does automatically) would burn it before the person ever
clicks. It shares its rate-limit bucket with confirm (`ratelimit:pwreset-confirm:${sub}`)
rather than getting its own, so a validate-spam loop can't be used to dodge the limit that
matters.

**The frontend got a small design-system's worth of new pieces**, built once and shared
across both places a password gets set (self-service reset, forced change): `Stepper`,
`IdentityCard` (who this password change is for -- read from the validate/change-token
response, not re-typed), `ExpiryCountdown` (`aria-live="off"` deliberately -- a ticking
timer announced every second would make a screen reader unusable; it fires its `onExpire`
callback exactly once via a ref guard, not on every re-render tick), `PasswordStrength`, and
`PasswordPolicyChecklist` (a plain list, not `role="radio"` -- it's not a mutually exclusive
choice, it's several independent booleans, and marking it up as radios would tell assistive
tech something false). `SetPasswordForm` wraps the actual input + these two live-feedback
pieces once, shared by `RecoveryPage`'s reset tab and `ForcePasswordChangePage`, so the two
screens can't drift apart on submit-button-disabled logic or error rendering.
`RecoveryPage`'s reset tab now branches on whether it was reached with `?token=` in the URL
(the rich flow, calling validate immediately) or pasted in by hand (a plainer fallback form,
same eventual confirm call) -- both still exist because a real emailed link and "I have a
code but no clickable link" are both real ways this screen gets reached.

**`AdminUsersPage`'s pt-BR pass reused the same live components** rather than re-implementing
password feedback a third time: the create-user form's temp-password field and each row's
inline reset-password field both run `evaluatePassword` against that specific
target's own email/name, live, gating their submit buttons on `.ok` exactly like the
self-service screens do -- so an admin typing a weak or name-containing temporary password
sees it rejected before the request round-trip, using the exact rule the server will also
enforce. The page kept its dark theme; only the strings, the name fields
(`firstName`/`lastName` required, `professionalRegistration` optional free text, not an
enum -- clinics use inconsistent council-registration formats and validating the format
wasn't in scope), and the role labels (now looked up in the `roles` i18n namespace instead of
rendering the raw `UserRole` enum value) changed. `DashboardPage`'s "Manage users" button that
links here stays English -- an accepted seam, the same kind `docs/architecture.md`'s rebrand
section already calls out for other pages translated on different passes.

**A real gotcha, hit repeatedly while writing fixtures for this phase's tests**: a fixture
whose password textually contains a substring of its own name or email defeats itself --
e.g. `firstName: "Cross"` paired with `password: "CrossTenant123!"` fails
`PASSWORD_POLICY_VIOLATION` instead of succeeding, because the policy is working exactly as
designed. Every new test fixture's password had to be checked against every other string
(name, email, brand words) in the same fixture, not just visually skimmed for "looks strong
enough."

## Clinic-scoped registration, invitations, and the active-clinic switch

The business rule this phase implements literally: "The System Administrator registers
users with the Clinic Manager, Supervisor, and Nursing profiles. The Clinic Manager
registers users with the Nursing profile. A Manager is linked to one or more clinics. A
Supervisor is linked to the clinic(s) of the responsible Manager." Four things had to
change to make that real, not just documented: **who may grant which role**, **a user
belonging to more than one clinic**, **onboarding without an admin-typed password**, and
**what a clinic even is relative to the operator company that runs its equipment**.

**`canGrantRole`/`ROLE_GRANTS` (`packages/shared/src/roles.ts`)** is the actual matrix, a
level narrower than the pre-existing `ASSIGNABLE_ROLES` ("every role that isn't
bootstrap-only"). `CLINIC_ADMIN` used to be able to register any of the 8 assignable roles,
including another `CLINIC_ADMIN` -- that's a real capability *removal*: it can now only
grant `NURSING`. Enforced in `RegisterUserHandler`, not `UsersController`, for the same
reason `isRoleAllowedInTenantType` already lived there: `infra/seeds/seed.ts` and
`bootstrap-superadmin.ts` dispatch `RegisterUserCommand` directly through the `CommandBus`,
bypassing HTTP (and any controller-level check) entirely. A `null` actor -- exactly the seed
scripts -- is exempt, mirroring the existing `actingUserId: null` exemption for the audit
trail.

**`UserClinicMembership`** is a real many-to-many join table, not a second `tenantId`.
`User.tenantId` keeps meaning exactly what it always meant -- the account's home/*active*
clinic, the one carried in the JWT -- and every existing `belongsToTenant` check across
~20 call sites (equipment, queue, sessions, iam, audit) needed zero changes, because from
their point of view a multi-clinic account still has exactly one `tenantId` at a time. What
changed is that `tenantId` can now change *without a full re-login*:
`POST /auth/active-clinic` re-mints the token pair against a different clinic the caller
belongs to (verified against `UserClinicMembership`, not trusted from the request),
`GET /auth/me/clinics` lists the switchable set, and `RefreshTokensHandler` re-validates the
refresh token's own `tenantId` against current membership on every refresh -- without that
last check, revoking someone's access to a clinic wouldn't take effect until their existing
refresh token happened to expire. The membership table also gets a real audit consequence
worth naming: a multi-clinic user's audit history lives across *separate* per-clinic hash
chains (`AuditLog`'s `(tenantId, seq)` chain), which is correct -- each clinic's history
verifies independently of any other clinic the same person also happens to touch -- but is
easy to misread as "missing" events if you go looking for them under the wrong tenant.

**Rule 2 ("a Supervisor is linked to the clinic(s) of the responsible Manager") is enforced
as a *state* check, not a foreign key.** There's no `responsibleManagerId` column on `User`.
Registering a `LOCAL_SUPERVISOR` for a clinic requires that clinic to already have at least
one `CLINIC_ADMIN` member (`UserClinicMembershipRepositoryPort.hasMemberWithRole`, joined
through the membership table rather than `user.tenantId` directly -- a Manager's *home*
clinic is just their default active one, and rule 1 lets them belong to several). This
reads the rule's practical effect ("a Supervisor needs a Manager to be responsible *to*")
rather than its literal wording, and was a deliberate simplification over adding a new FK
that nothing else in the UI (the registration screen this was built from shows a clinic
picker for a Supervisor, not a "pick your manager" field) actually called for.

**Invitations replace the admin-typed temp password entirely.** `CreateUserRequestSchema`
lost its `password` field outright -- `POST /users` sets no credential at all anymore.
`RegisterUserHandler` hashes a random, permanently-unusable placeholder (never logged, never
emailed, never compared against anything a real login could produce) and leaves
`activatedAt` null; `SendInvitationHandler` mints a single-use, 24h,
jti-denylistable token (same shape as the password-reset token, new `"account_invitation"`
revocation kind) and emails an `/ativar-conta?token=` link. `LoginHandler` rejects an
unactivated account outright (`isActivated()`), and -- symmetrically --
`RequestPasswordResetHandler` now treats an unactivated account exactly like a locked one:
a silent no-op, because a password-reset link would just be a second, redundant way to set
an account's first password, and issuing one would leak "this email has a pending account"
the same way locked/deactivated silence already exists to prevent. Unlike password-reset's
own request handler, sending an invitation is *authenticated* (an admin, not a public form),
so there's no enumeration risk to defend against -- the send is awaited and a real failure
is surfaced to the caller, not fired-and-forgotten.

**Clinic vs. operator vs. unit, settled for this pass.** A clinic and an operator company
are both `Tenant`s (`CLINIC` / `OPERATOR_PROVIDER`) -- that didn't change. What's new: a
clinic tenant can have a nullable `operatorTenantId` pointing at the one operator company
that runs its equipment ("one clinic has one operator tenant, one operator tenant can serve
many clinics" -- a plain self-FK, not a join table, because the relationship really is
one-to-at-most-one in that direction). `OPERATOR`/`OPERATIONAL_SUPERVISOR`/`OPERATOR_ADMIN`
deliberately keep their pre-existing ability to *also* belong directly to a CLINIC tenant
(unchanged from before this phase) -- tightening that to OPERATOR_PROVIDER-only would have
broken the existing seed data and every account created that way, for no benefit this phase
actually needed. A clinic can also now have more than one `Unit` ("like a hospital -- a
clinic/company can run more than one"); `Equipment.unitId` was added alongside the
pre-existing `Equipment.tenantId` rather than replacing it, specifically so none of the
~20 tenant-scoping call sites above had to change to add units at all. Deliberately
*not* built in this pass: a Units admin screen, and equipment create/edit wiring to pick a
unit -- the model, the API, and the seed data are real and exercised end-to-end by
`clinic-membership.e2e.spec.ts`, but new equipment stays unassigned to a unit until that
follow-up UI exists. Existing equipment was backfilled onto each clinic's own generated
"Unidade Principal" in the same migration that added the column.

**`AdminUsersPage`'s create form** builds its role dropdown from `ROLE_GRANTS[actingUser's
role]`, not the full assignable-roles list -- a `CLINIC_ADMIN` is shown exactly one option
(`NURSING`), never a role the server would 403 anyway. The clinic picker is a plain
accessible checkbox `<fieldset>`, not a custom chip-remove widget: this repo has no
component library and hand-building a fully keyboard/ARIA-correct multi-select chip picker
correctly was judged not worth the risk against the axe-core a11y tier that actually gates
this page, versus a native checkbox group that gets that correctness for free. Where the
acting admin's own clinic options come from depends on who's asking:
`GET /tenants` (every clinic) for a PLATFORM_ADMIN, `GET /auth/me/clinics` (only the
caller's own memberships) for a CLINIC_ADMIN -- mirroring exactly what
`RegisterUserHandler`'s own actor-scope check allows, so the picker never even offers a
choice the server would reject.

## Follow-up: Units UI, the equipment<->unit wiring, the console shell, and the permission summary

The previous phase shipped a `Unit` model, a `UnitsController`, and `Equipment.unitId` as a
real backfilled column -- with zero application-layer wiring behind any of it. This phase
closed those three gaps for real, plus the two purely-UI ones (a shared shell, a permission
summary) that had been deferred alongside them.

**A real security gap was found and fixed before any UI got to sit on top of it.**
`CreateUnitHandler`/`ListUnitsByClinicHandler` trusted `clinicTenantId` outright -- any
authenticated CLINIC_ADMIN/LOCAL_IT/OPERATOR_ADMIN could create or list units under a
clinic they had nothing to do with, as long as it existed and was type CLINIC, and unit
creation emitted no audit event at all (every other `create` handler in this codebase
does). `ClinicAccessChecker` (`modules/units/application/clinic-access-checker.ts`) is the
fix: a caller may act on a clinic if they're PLATFORM_ADMIN, it's their own home tenant,
they have a real `UserClinicMembership` row for it, or -- the first real use of the link --
their own home tenant is the OPERATOR_PROVIDER tenant linked to it via
`Tenant.operatorTenantId`. Both handlers call it now; `CreateUnitHandler` also records
`AuditAction.UNIT_CREATED`.

**`Equipment.unitId` is wired end-to-end, with an explicit default policy, not left
optional-forever.** An explicit `unitId` on create/update is validated against the
equipment's own tenant (403 if it belongs to a different one). An *omitted* one on create
auto-resolves to the tenant's oldest unit -- and if the tenant has none yet (a brand-new
clinic created after this shipped, which gets no migration backfill), `CreateEquipmentHandler`
creates a default "Unidade Principal" on the fly, so a new Equipment row is genuinely never
left without one, honoring what the schema's own comment on the column already promised
before any code actually did it. `EquipmentModule` now depends on `UnitsModule` for this
(`UNIT_REPOSITORY`) -- a one-directional edge, no cycle.

**`ConsoleShell`** is the shared sidebar+topbar chrome for Dashboard, Gestores & Usuários,
the new Unidades page, Equipamentos, and the superadmin Tenants page -- closing a
duplication that existed from the very first admin page onward (each one independently
re-implemented its own `<header className="topbar">...<main className="page">`). Built
against the original RadLink console mock, with three deliberate substitutions rather than
literal reproductions, each because the literal version would have asserted something not
true of this codebase:
  - the mock's fabricated `"GRID DICOM / PACS: ONLINE · 12ms (TLS 1.3)"` topbar pill becomes
    a real equipment-health aggregate (`GET /equipment`, online/total count) for the
    caller's own active clinic -- there is no DICOM/PACS integration anywhere in this app;
  - the mock's sidebar footer read `"DICOM PACS 14 / v3.8.4 HIPAA"` and "credenciados
    CFM/SBIS" -- an explicit regulatory-compliance claim this codebase has made no attempt
    to actually satisfy or document anywhere else. Dropped for a neutral version stamp;
  - the mock's "Configurações" gear is dropped outright (nothing exists behind it); the
    notification bell stays, but purely as inert, `aria-hidden` decoration -- there is no
    notification system to back it.

This is also the point where `AdminUsersPage` reverses its own earlier "keep the dark
theme" decision (see the pt-BR-pass entry above) -- `ConsoleShell` is light-theme only, to
match the mock, and every page that adopts it moves with it. `SessionPage`, `AuditPage`,
`ClinicHomePage`, and `LatencyClockPage` deliberately do not: different concerns (a
full-bleed video console, a page with no nav needs, stubs), not part of the mock this was
built from. `lib/nav-permissions.ts`'s `computeNavPermissions` is the one place the
`canView*`/`canManage*` role sets are computed now, consumed by both `DashboardPage` and
`ConsoleShell` -- previously `DashboardPage` computed its own copy independently of
`App.tsx`'s `RoleRoute` lists (which stay separate on purpose: they're the actual
authorization UX gate, not just "should a nav item render").

**The read-only permission summary (`RolePermissionSummary` / `ROLE_CAPABILITIES`)**
deliberately does not reproduce the original mock's three example checkboxes verbatim.
Two of the three -- "Relatórios de Produtividade" (productivity reports), "Supervisão de
Intercorrências" (incident supervision) -- don't correspond to any real feature anywhere in
this codebase (there is no reports feature, no incident-tracking feature at all).
`ROLE_CAPABILITIES` lists only capabilities traced back to a real, already-enforced
`@Roles` decorator on some controller; nothing here is itself enforced, and nothing here
invents a capability to fill out the mock's shape. This is also, deliberately, not the
larger "real per-user permission grants, independent of role" system that would actually
let one specific Supervisor's access differ from their role's default -- that's a genuinely
different capability (per-user overrides), not a UI gap, and wasn't asked for.

## The equipment registry: a scanner's clinical identity, and why "delete" is a timestamp

Until this phase, `Equipment` described only the *console* this platform drives: PiKVM host and
credentials, target OS, keymap, screen size. Nothing recorded what the device actually is — no
modality, brand, model, serial number, or room — even though the platform's whole subject is
remote operation of MRI/CT scanners. That gap is now closed, and three decisions inside it are
worth recording because in each case the obvious implementation is quietly wrong.

**The new clinical columns are nullable, and are not backfilled.** `Unit.unitId`'s own rollout
set the precedent for backfilling a new column, and it was correct there: "this clinic's only
unit" is a real, derivable default. There is no equivalent for a brand, a model, or a serial
number. Inventing one would put fabricated asset-tracking data into the exact rows an ANVISA
calibration record is meant to be traceable against. So pre-existing rows keep NULLs, and the
thing that stops the null set from growing is `CreateEquipmentRequestSchema` requiring all six
fields — not a `NOT NULL` constraint, which this migration cannot honestly add while those rows
exist. That makes the requirement a *contract* guarantee rather than a database one, which is
why `packages/shared/tests/equipment-contract.test.ts` and
`apps/api/test/equipment-registry.e2e.spec.ts` both assert it directly: if it regresses,
nothing else in the system would fail.

**Deactivation is `deactivatedAt`, not an `EquipmentStatus.INACTIVE`.** The first design
(approved before this was understood) was to express "retired" as a status transition to
`OFFLINE`, reusing the existing `UpdateEquipmentStatusCommand` — it looked like the
tenant/unit deactivation precedent and needed no new column. It does not work at all.
`PiKvmHealthPoller` rewrites `status` for every non-`MAINTENANCE` device every 10 seconds, so a
retired scanner whose hardware is still physically reachable would come back `ONLINE` by itself
within one poll cycle, fully operable. `status` is a *health* field owned by the poller and
cannot also carry a lifecycle decision made by a human. The fix is an orthogonal nullable
timestamp — matching `Tenant.deactivatedAt`/`Unit.deactivatedAt`, which is what the
tenant/unit precedent actually was all along — plus two changes that make it real:

- `PiKvmHealthPoller` skips deactivated equipment, for a different reason than it skips
  maintenance: not to protect an override, but because polling a decommissioned device is work
  whose result nobody acts on, and if the hardware still answers it would flap the row between
  `ONLINE` and `OFFLINE` forever, writing an audit row per transition.
- **`StartSessionHandler` no longer compares `status` itself.** It called
  `equipment.status !== EquipmentStatus.ONLINE` inline; `Equipment.isAvailableForSession()`
  existed but was dead code. Because the poller now skips retired equipment, a scanner retired
  while healthy keeps a frozen `ONLINE` status indefinitely — so the inline check would have
  started sessions on decommissioned devices forever. The predicate now encodes both
  conditions and the handler delegates to it.

The regression test for this (`equipment-registry.e2e.spec.ts`, "refuses to start a session on
retired equipment whose frozen status still says ONLINE") deliberately drives the device to
`ONLINE` first and asserts the frozen value is still `ONLINE` after retirement, so it is
testing the actual hazard rather than a device that happened to be offline anyway. Verified
live as well, against the mock PiKVM with the real poller running: registered, observed
`ONLINE` by the poller, retired, still `ONLINE` a full poll cycle later, session refused with
`CONFLICT`.

**There is no `DELETE /equipment/:id`, and it is not a stylistic preference.** `Session` and
`QueueEntry` hold real foreign keys to `equipment`, and `AuditLog` rows reference sessions.
Attempting the delete directly against Postgres during verification produced exactly that:
`violates foreign key constraint "sessions_equipmentId_fkey"`, and the cascade's attempt to
null `audit_logs.sessionId` was in turn refused by the append-only trigger
(`crop_audit_logs_immutable`). A hard delete is either impossible or destroys the audit history
the trigger exists to protect. Retirement is the only correct shape for this operation.

A deliberate non-behaviour: **retiring equipment does not abort a session already running on
it.** Ending a live remote-control session on a clinical device because an administrator
clicked a trash-can icon in another tab is the more dangerous of the two options — the operator
may be mid-procedure. The session ends the way any session ends, and no new one can start
afterwards. (There is also a structural reason: aborting would make the equipment module depend
on the sessions module, which already depends on it.)

### DICOM fields that are recorded and never used

The equipment mock this screen was built from is dense with PACS/compliance furniture: a
"Sincronizar PACS" button, a "Gateway Local … VPN IPSec RadLink Ativa / PRONTO PARA
PAREAMENTO" banner, and `ISO 13485` / `DICOM PART 14` / `PROTOCOLO ADM EQ-2024` /
`Validação Automática` / `LGPD … CFM / SBIS` badges. None of it is reproduced, for the same
reason `ConsoleShell` dropped the mock's fabricated `GRID DICOM / PACS: ONLINE` pill and its
`HIPAA` footer (see that section above): this codebase has no DICOM/PACS integration and has
made no attempt to satisfy those standards, and a button claiming to synchronise a PACS is
worse than no button.

The AE Title / host / port *fields* are kept, because "record what the PACS team gave us" is a
real thing an operator wants of an equipment record even when this platform never reads it.
They are optional, and the form states plainly, where they appear, that the platform
establishes no DICOM connection. AE Title is still validated to DICOM PS3.5's real constraint
(≤16 characters, uppercase alphanumerics plus `_`/`-`) — validating a field this app does not
consume is worthwhile precisely because something *else* does.

### Client-side filtering, and where that stops being right

The listing screen's search, status/modality/unit filters, summary counts, pagination and CSV
export all run in the browser over the full array `GET /equipment` returns. `GET /equipment` has
always been unpaginated, no list in this app is server-paginated, and a clinic's fleet is tens
of devices. Keeping it in one place means the four summary cards, the table and the export
cannot disagree with each other, which a separate `/equipment/stats` endpoint would make
possible for no benefit at this size. The point where this flips is a tenant large enough that
the payload itself hurts: at that point the filters become query parameters *and* the counts
need their own endpoint, because they stop being derivable from one page of results.

The summary cards also do not reproduce the mock's three-bucket split (Ativos / Manutenção /
Inativos), because this system has four real states and `DEGRADED` fits none of those buckets
honestly — it is neither operating normally nor out of service. It is counted separately and
surfaced as a note, rather than folded into a bucket where it would be a lie about a device
with a connection problem. `EquipmentDto.deactivated` also has to be read *before* `status` when
rendering a single pill, since a retired device's status is frozen and often still `ONLINE`;
that ordering lives in one place (`lib/equipment-display.ts`) rather than being re-derived by
the table, the counters and the export.

### Three pre-existing defects this work surfaced

None of these were caused by the equipment feature; all three were found by testing it.

1. **`.btn.secondary` was unreadable in the light theme.** `.btn` sets
   `color: var(--color-btn-primary-fg)` (white) and `.btn.secondary` overrode only the
   background — `#e4e9ee` in `.theme-light` — giving white-on-near-white at **1.22:1** against
   WCAG AA's 4.5:1, on every secondary button in the light console chrome including
   `ConsoleShell`'s own "Sair". Fixed at the source (`color: var(--color-fg)`, correct in both
   palettes), plus explicit rules for anchors styled as buttons, which otherwise inherit the
   global `a { color: var(--color-accent) }` and an underline.
2. **Every form displayed validation errors as `[object Object]`.** `ZodValidationPipe` answers
   a 400 with an *array* of `{path, message}`, and `api-client` passed it straight to `new
   Error(...)`. `ApiError` now carries `fieldErrors` and a readable joined message, so a
   field-level rejection can be mapped back onto the input that caused it.
3. **The a11y suite could not reach four of the pages it claimed to scan.** Several tests still
   clicked `button "Manage users"` / `"Manage equipment"` / `"Manage tenants"` on
   `DashboardPage` — removed when that navigation moved into `ConsoleShell`'s sidebar — so they
   failed on a missing locator before axe ran at all. Navigation repaired; two hardcoded
   `#9aa4b2` muted-grey values on light-theme cards (`DashboardPage`, the tenant-management page
   that has since become `AdminClinicsPage`, 2.52:1) were then found by the scan and switched to
   `var(--color-muted)`.

Still outstanding, and deliberately left alone as it needs a decision spanning all five admin
pages: **`ConsoleShell` renders its `pageTitle` as a `<strong>`, not a heading**, so
`DashboardPage` has no `<h1>` at all (axe `page-has-heading-one`) and the "Admin users page"
a11y test waits on a `heading "Usuários"` that does not exist. The equipment/unit/clinic pages
are unaffected — they carry their own real `<h1>` inside their own `page-head` markup, the
pattern `AdminClinicsPage` also adopted when it replaced the old `SuperadminTenantsPage` (which
*was* one of the two affected pages at the time this was first written; it no longer exists).
Promoting `pageTitle` to an `<h1>` in the shell would fix `DashboardPage` at a stroke and would
then want that page's own `<h2>`s demoted to `<h3>`. Two further a11y failures
(`ForcePasswordChangePage`, "Activate account page") are also pre-existing: the first posts
`POST /users` with a `password` and `role: OPERATOR`, neither of which survived the move to
invitation-based onboarding and `ROLE_GRANTS`; the second cascades from the users-page failure
above. All four remain reproducible as of the clinic registry below — confirmed by running the
full suite with the underlying page-crash bug that phase introduced (see its own writeup)
already fixed, so these four are not a byproduct of that bug or of anything in this feature.

## The unit registry: why deactivation had to become a real cascade, not a status value

`Unit` grew from five columns (id, clinic, name, `deactivatedAt`, `createdAt`) to an actual
institutional record: establishment type, declared modalities, a technical manager, a full
address, and optional CNES/contact fields. Same shape of change as the equipment registry
before it, and it repeats one of that phase's real findings rather than a new one — but two
things here are genuinely new, and one bug fix was overdue independently of this feature.

**`ClinicAccessChecker` never checked whether the clinic was deactivated, despite
`CreateUnitHandler`'s own comment already claiming it did.** A unit could be created under a
deactivated clinic, silently contradicting this feature's own first business rule ("a unit
is always linked to a clinic that is already registered"). Fixed by checking
`clinic.isDeactivated()` right after the existence/type check, applying to every actor
including `PLATFORM_ADMIN` — this is not a permission question ("can PLATFORM_ADMIN act on
this clinic," which they always can), it's "is this clinic even eligible to have units
managed," the same way the existing type check already refuses a non-`CLINIC` tenant for
everyone. `units-clinic-access.e2e.spec.ts` covers it, including the case that would have
looked most legitimate: the clinic's own admin, acting on their own home tenant, refused.

**The technical manager ("Gestor Técnico Local") has to be a real, already-registered user
of the *target* clinic, holding an eligible role** (`CLINIC_ADMIN`, `LOCAL_SUPERVISOR`, or
`LOCAL_IT` — see `TECHNICAL_MANAGER_ELIGIBLE_ROLES`), activated, and not locked.
`TechnicalManagerValidator` enforces this on both create and update, shared so the rule can't
drift between the two paths. It inherits a real, documented limitation from `GET /users`
itself: eligibility is checked against the candidate's *home* tenant, the same scoping every
other admin list in this app already uses, so a multi-clinic manager whose home tenant is a
*different* clinic (reachable only through a `UserClinicMembership` row) is rejected even
though they can otherwise act on this clinic. This bit the **seed script** directly: Beta had
no `CLINIC_ADMIN`/`LOCAL_SUPERVISOR`/`LOCAL_IT` account at all before this feature (only an
`OPERATOR`), so "Unidade Centro" had no eligible candidate to name until `admin@beta.crop.health`
was added.

**The technical manager's display name and professional registration are denormalized onto
the unit's own DTO** (`UnitSchema.technicalManager`), not left as a bare id for the frontend
to resolve. The prototype's "CREDENCIAÇÃO CFM OK" badge next to this person is not
reproduced — nothing in this platform verifies a CFM/CRM registration against any registry,
the same reasoning `docs/architecture.md`'s equipment section already applied to the
"Validação Automática" and "CEP validado na base dos correios" claims elsewhere in this same
mock family. The registration number is shown exactly as recorded, with no verification
claim attached.

**Deactivating a unit had to become a real cascade into its equipment's session
eligibility, not a status value on the unit itself, and specifically not on
`Equipment.status`.** The obvious-looking design — express "this unit is out of service" by
setting every one of its equipment rows to `OFFLINE` — repeats the exact mistake the
equipment-retirement phase already made and fixed once: `PiKvmHealthPoller` rewrites
`status` for every non-`MAINTENANCE`, non-deactivated device every 10 seconds, so a bulk
`OFFLINE` write would be overwritten back to `ONLINE` within one poll cycle for any device
whose hardware is still reachable. The actual fix has two parts:

- `SetUnitDeactivatedHandler` touches only `units.deactivatedAt`. It does not iterate the
  unit's equipment at all, deliberately: a device keeps its own independent `deactivatedAt`,
  so reactivating the unit later cannot silently un-retire equipment an admin retired for an
  unrelated reason in between (`equipment-registry.e2e.spec.ts`'s
  `does not resurrect equipment an admin retired independently` test is the regression guard
  for this specific interaction between the two deactivation flags).
- `StartSessionHandler` gained a second check, after the existing
  `equipment.isAvailableForSession()` one: if the equipment has a unit, load it and refuse
  with `ConflictError` when that unit is deactivated. This has to live in the *session*
  handler, not on the `Equipment` entity itself (unlike the equipment-retirement check,
  which does live there) — `Equipment` has no knowledge of `Unit` as a concept; the unit is
  a different aggregate the session handler already reaches into. Verified live against the
  real health poller and the mock PiKVM, not just in the e2e suite: registered a scanner,
  waited for the poller to genuinely observe it `ONLINE`, deactivated its *unit* (not the
  equipment), confirmed a session request still failed with a message naming the unit, and
  confirmed `equipment.status` stayed `ONLINE` throughout — the poller has no idea the unit
  exists, so nothing corrects that frozen-but-irrelevant value on its own.

**Unit names are unique per clinic, case-insensitively** — a hand-written functional index
(`units_clinicTenantId_lower_name_key`), the same "Prisma's schema language can't express
this" precedent `audit_append_only` and `one_active_session_per_equipment` already set.
Verified against every existing row before writing the migration: no collision. This also
bit the a11y test suite in a way worth recording — the equipment a11y test reuses a fixed
literal name (`"A11y Scanner"`) across every run, harmless because equipment names aren't
constrained; copying that pattern for the *unit* form test's fixed `"A11y Unit"` produced a
real `409 CONFLICT` on the second run, because deactivating a unit at the end of a test run
(the correct cleanup — there is no delete) does not free its name. Fixed by embedding the
same per-run random suffix already used for the test's CNES code into the unit's name too.

**Rooms are derived from equipment, not promoted to their own table**, continuing the
decision `Equipment.roomLabel`'s own migration already made and explicitly left open
("promote to a real entity if that changes"). Nothing changed: this feature's "Salas /
Gantry" stat is `PrismaUnitRepository.summarizeEquipment`'s distinct-`roomLabel` count among
a unit's non-retired equipment — this API's first `groupBy`, needed only because
`GET /equipment` is tenant-scoped and a platform admin viewing another clinic's units has no
client-side way to derive it the way every other count in this app is derived.

**The `?scope=all` cross-clinic listing is genuinely more correct than the sourcing pattern
the listing page's own clinic filter and CSV export use for display names.**
`ListAccessibleUnitsHandler` computes accessible clinics the same way
`ClinicAccessChecker.assertCanAccessClinic` already permits them (home tenant, membership,
operator link, or every `CLINIC` tenant for `PLATFORM_ADMIN`) — which, unlike
`GET /auth/me/clinics`, correctly includes a clinic reachable only through
`Tenant.operatorTenantId`. The frontend's `clinicOptions` (sourced from `GET /tenants` or
`GET /auth/me/clinics`, purely for labels and the filter dropdown) still has that gap, since
fixing `ListMyClinicsHandler` itself is a pre-existing issue this feature inherits rather
than owns. The practical effect: an `OPERATOR_ADMIN` whose only clinic access is an
operator link now sees that clinic's units in the list (a real improvement over the old
single-clinic default, which called `ClinicAccessChecker` with their non-`CLINIC` home
tenant and would have 403'd), but the clinic name in that row falls back to a raw id, the
same graceful degradation `AdminEquipmentPage`'s own unit-name lookup already uses for an
id it doesn't recognize.

## The clinic registry: CNPJ as the source of truth for matriz/filial, and two more "unwrap the enriched command result" bugs

`Tenant` (already the backing table for a "clinic") grew the same way `Unit` did before it:
from a bare `id`/`name`/`type`/`deactivatedAt` row into an actual institutional record —
CNPJ, institutional e-mail, phone, a full registered address, and an optional responsible
manager — behind a reshaped `/superadmin/clinics` (formerly `/superadmin/tenants`) screen.
Same shape of change as equipment and units before it, and it repeats that phase's real
findings rather than inventing new categories of bug, but a few decisions here are genuinely
new.

**CNPJ gets the same validation depth `AeTitleSchema` gave DICOM AE Titles: the real
algorithm, not just the shape.** `isValidCnpj` (`packages/shared/src/cnpj.ts`) runs Brazil's
actual mod-11 check-digit algorithm against the normalized 12-digit base, and separately
rejects a degenerate all-same-digit string (`"11111111111111"` passes the naive 14-digit
format check but is never a real CNPJ) — the same "storing a value a real external system
would reject is worse than storing nothing" reasoning the AE Title validator already
established. Stored as normalized digits-only, globally unique (`Tenant.cnpj`'s own unique
index, with a friendly pre-check in `CreateTenantHandler` ahead of it so a collision surfaces
as a real field error, not a raw constraint-violation 500); `formatCnpj` is presentation-only,
applied at the edges (the listing table, the CSV export, the read-only view), never stored.

**Matriz/filial is derived from the CNPJ itself, not a new relationship column.** A CNPJ's
root — its first 8 digits — identifies the corporate group; the next 4 (branch order)
distinguish members of it, and `0001` is specifically reserved for the matriz
(`cnpjRoot`/`isMatriz` in `cnpj.ts`). This was a real design choice, not the default: the
mock's own prototype implied a parent-child "this clinic belongs to that clinic" pointer, but
the data to derive the same relationship, more cheaply and with no possibility of drifting
out of sync with the CNPJ that's the actual legal source of truth, was already going to exist
on every clinic row the moment CNPJ became a field at all. `isMatriz`/`cnpjRoot` on the DTO
are `null` in exact lockstep with `cnpj` — there is no branch role to derive from a CNPJ that
was never recorded (a row that predates this feature, or the one PLATFORM tenant, which has
no CNPJ at all and never will).

**`cnpj` and `type` are immutable after creation — not merely "not shown as editable" on the
frontend, but structurally absent from `UpdateTenantRequestSchema`.** Changing either after
the fact would either silently re-parent a clinic's whole matriz/filial group (CNPJ) or
violate an invariant every `@Roles`/tenant-type check elsewhere in this codebase already
assumes holds for a tenant's entire lifetime (`type`). Both are the same "correcting this
means creating a new row, not editing this one" shape `UpdateUnitRequestSchema` already
established for `clinicTenantId`. `ClinicFormPage` reflects this directly: the CNPJ input is
a real, editable field only in create mode; edit and view both render it as plain read-only
formatted text regardless of the form's own read-only state, the same non-interactive-
regardless-of-mode treatment `UnitFormPage` already gives its own immutable clinic picker.

**The equipment/modality section the mock showed for a clinic is not reproduced — that data
already lives, and is edited, exactly once each, on Equipment's and Unit's own forms.**
`equipmentCount`, `unitCount`, and the distinct exam modalities across a clinic's own
non-retired equipment are computed server-side (`PrismaTenantRepository.summarizeClinics`,
this API's second cross-clinic `groupBy` after `PrismaUnitRepository.summarizeEquipment`'s
own for rooms) and denormalized onto the enriched `TenantDto` for display — the create/edit
form has no equipment section at all to re-enter or drift out of sync with either of those.
Retired equipment counts toward `equipmentCount` (still real inventory) but is excluded from
`modalities` (a retired scanner's modality isn't something the clinic can actually offer
anymore) — the identical asymmetry the unit registry's own room-vs-equipment count already
established, applied here one level up the hierarchy.

**The responsible manager is optional at creation and assignable only on edit — a narrower
eligibility set than a unit's technical manager, and for a different structural reason than
"optional."** A brand-new clinic has no users yet at all (chicken-and-egg:
`CreateTenantRequestSchema` doesn't accept `responsibleManagerId` in the first place, not
even as an ignored field), so `ClinicFormPage`'s create mode shows a note pointing at
Gestores & Usuários instead of an empty, useless picker. `ResponsibleManagerValidator`
restricts eligibility to an already-registered, activated, unlocked **`CLINIC_ADMIN`** of
that same clinic — where `TechnicalManagerValidator` accepts three roles
(`CLINIC_ADMIN`/`LOCAL_SUPERVISOR`/`LOCAL_IT`) for a unit's technical manager, a clinic's
overall responsible manager is deliberately narrower: the person accountable for the whole
clinic should be the clinic's own administrator, not any of its site-level staff.

**No deactivation cascade was needed here, unlike equipment retirement and unit
deactivation before it — verified rather than assumed.** The obvious question, given both
prior features needed one, was whether deactivating a clinic needed to reach into its
sessions or equipment the same way. It doesn't: `LoginHandler` and `RefreshTokensHandler`
already call `tenant.isDeactivated()` and reject outright for every one of that tenant's
users, so a deactivated clinic already can't log anyone in or refresh anyone's session —
the cascade equipment/unit deactivation each had to build by hand here falls out of a check
that already existed for an unrelated reason (the original tenant-lifecycle feature).
Confirmed by reading both handlers rather than by adding and then discovering a redundant
check.

**Two more instances of this project's most-repeated bug pattern: an
`Enriched*`-returning command silently breaks a caller that still expects the bare entity.**
Once `CreateTenantCommand`/`ListTenantsQuery` were reshaped to return `EnrichedTenant`
(`{ tenant, equipmentCount, unitCount, modalities, ... }`) instead of a bare `Tenant`, two
existing, non-typechecked call sites broke exactly the way `infra/seeds/seed.ts` already
broke twice before (once for equipment, once for units) — the same root cause `README.md`'s
own bug table already lists under "`infra/` scripts have zero typecheck coverage anywhere in
this monorepo's toolchain," recurring because nothing about that gap changed:

- `seed.ts` itself needed a third fix in the same file: `const { tenant: alpha } = await ...`
  instead of `const alpha = await ...`, for both clinics.
- `infra/seeds/bootstrap-superadmin.ts` had a *latent* version of the same bug, worse than a
  crash: its own idempotency check (`existingTenants.find(t => t.type === PLATFORM)`) was
  reading a stale-typed `Tenant[]` against what `ListTenantsQuery` now actually returns,
  `EnrichedTenant[]` — `.find` against the wrong shape doesn't throw, it just never matches,
  so every re-run of the bootstrap script would have silently created a second PLATFORM
  tenant instead of recognizing the first one already existed. Fixed to
  `existingTenants.map(entry => entry.tenant).find(...)`, and verified live: reset the
  database, ran the script twice in a row, confirmed the second run printed "Already
  bootstrapped" instead of creating a duplicate.

**A stale Vite dependency pre-bundle cache produced a real, if short-lived, frontend crash
during this feature's own a11y verification pass — worth recording because the symptom looked
nothing like its cause.** `apps/web`'s Vite dev server pre-bundles `@crop/shared` into
`node_modules/.vite/deps/@crop_shared.js` and only re-bundles it when its own change-detection
heuristics (roughly: the workspace lockfile/config) say to — not on every edit to
`packages/shared`'s own source or a rebuild of its `dist/`. Restarting the dev *server*
process (done here after several unrelated file edits) does not clear that cache; only
deleting `node_modules/.vite` or passing `--force` does. The result: `clinic-display.ts`'s
`import { formatCnpj } from "@crop/shared"` resolved, at runtime, against a bundle frozen
before `cnpj.ts` existed at all, throwing `formatCnpjDigits is not a function` the instant
`AdminClinicsPage` tried to render a row — an uncaught render error that axe-core's own a11y
scan reported as the page having no `<main>` landmark and no `<h1>`, since by the time it ran
the whole React tree had failed to mount. Nothing about the *application* code was wrong; the
fix was `rm -rf apps/web/node_modules/.vite` and a fresh dev server start. Recorded here
because the failure mode is a trap for exactly this kind of change: adding a new named export
to `@crop/shared` and consuming it from `apps/web` in the same session, without a `--force`
Vite restart in between, reproduces this every time.

**A pre-existing, unrelated `nest build` failure was found (not fixed) while running this
feature's own a11y verification, and is worth flagging loudly since it can silently make the
a11y suite's failures look worse than they are.** `packages/shared/src/contracts/session.ts`
carries real, uncommitted changes from an in-progress "nursing lock banner" feature
(`operatorName`/`controllerName`, denormalized via a `SessionParticipantNameService` that
does not actually exist anywhere in `apps/api/src`) — the contract was updated but
`session.dto.ts`'s own mapper was never updated to match, and `UserRepositoryPort` grew a
`summarizeDisplayNames` method that `PrismaUserRepository` never implemented. Both make
`nest build` (strict `tsc`, unlike `ts-node`/`nest start --watch`'s looser transpile-only
mode) fail with real `TS2739`/`TS2420` errors — deterministically once `packages/shared`'s
own `dist/` is rebuilt (as this feature's own verification pass did, to pick up `cnpj.ts` and
the reshaped `tenants.ts`; before that, a stale-but-internally-consistent `dist/` masked the
gap). `queue.ts`'s own equivalent-looking diff (`preparationStatus`/`positionedAt`/etc.) is
*not* actually broken — `queue.dto.ts` already maps every one of those fields; an earlier,
noisier build attempt against a mid-flight `tsconfig.tsbuildinfo` briefly reported it too,
and re-running cleanly showed only the two real gaps above.

This has no effect on `pnpm --filter @crop/api test:e2e` (runs against source directly, no
`nest build` involved) or the running dev server (`nest start --watch`, same), which is why
the demo stack, every e2e test, and this feature's own two dedicated a11y tests all pass
cleanly against a *live* server regardless. It does mean `make demo-reset` and this test
file's own `test.beforeAll` (which shells out to `pnpm bootstrap:superadmin`, itself
`nest build && tsx ...`) fail outright — and, since `workers: 1` restarts the Playwright
worker (re-running `beforeAll`) an unpredictable number of times across a 15-test file, a
**whole class of the a11y suite's other pre-existing failures**
(`ForcePasswordChangePage`, "Admin users page", "Activate account page", "Session page and
replay page" — none touched by, or related to, the clinic registry above) becomes
non-deterministic: whichever test happens to land on a worker restart fails outright with
"Command failed: pnpm bootstrap:superadmin" instead of ever reaching axe. **This also means
`.github/workflows/ci.yml`'s own `pnpm --filter @crop/api build` step is currently broken on
this branch**, independent of anything in this feature — left unfixed here because closing it
needs whoever owns `SessionParticipantNameService`/`summarizeDisplayNames`'s actual intended
behavior, not a guess at one from a session that never touched either.

## Nursing: queue reorder + editable exam details

A follow-up task on the same role and the same source prototype ("Modo Reordenação de Fila")
as the earlier patient-preparation quick-action feature (`NursingPage`, `PreparationStatus`)
— two new business rules: **reorder a room's patient queue**, and **each queue entry keeps
editable exam details with a real Save button**.

**Reorder is a full explicit ordering, not a single move-to-index operation.**
`POST /queue/reorder` takes `{ equipmentId, orderedIds }` — the room's entire proposed
WAITING-patient order — rather than `{ queueEntryId, newPosition }`. Three reasons: it's
idempotent (resubmitting the same order twice is a no-op, not a double-move — see
`ReorderQueueHandler`'s own no-op short-circuit); it matches what the UI actually
accumulates while a nurse drags/arrows several cards before confirming once; and it lets the
server validate the *whole* proposed order against the *whole* current WAITING set in one
atomic check, rather than trusting a sequence of individually-valid-but-collectively-stale
moves.

**Only `WAITING` entries ever participate, and non-participants keep their exact position.**
An entry already `IN_PROGRESS` is on the table; `DONE`/`CANCELLED` is finished history —
neither has a "priority" left to reorder. `planQueueReorder`
(`apps/api/.../queue/domain/queue-order.ts`, kept pure and separate from the handler)
renumbers the WAITING subset into exactly the position slots that subset already
collectively occupied, ascending — so a reorder never has to touch, or even know about, any
entry outside the WAITING set, and the surrounding entries' own positions never move.

**Two distinct 409s, not one generic "conflict".** `INCLUDES_NON_WAITING` (a patient in the
submitted order left WAITING since the client last loaded — an operator started or ended
their session, or someone cancelled them) is a different, more specific problem than
`STALE_SET` (the submitted set doesn't match the current WAITING set at all — e.g. another
nurse added or removed a patient mid-drag). Both are real 409s a nurse's UI can act on
differently, not a single "reload and hope" message.

**Deliberately no unique constraint on `position`.** A full renumber inside one transaction
would collide mid-update against a naive unique index without a deferrable constraint, which
Prisma cannot express. Ordering integrity instead comes entirely from the handler's own
full-set permutation check before anything is written — verified in
`queue-reorder.e2e.spec.ts` by asserting the resulting positions are contiguous and ascending
after a real reorder, not by trusting a DB constraint that isn't there.

**One audit row per reorder *act*, not per moved entry** (`AuditAction.QUEUE_REORDERED`),
mirroring `PATIENT_POSITIONED`/`INJECTED`/`RELEASED`'s "one action, one row" shape but at the
granularity the nurse's own "Confirmar Nova Sequência" button actually commits at.
`details` carries `previousOrder`/`newOrder` as queue-entry ids only — never
`patientFirstName`, the same PHI rule every other queue audit row already follows, verified
directly in the e2e suite by asserting the serialized audit details never contain a seeded
patient's name.

**Exam details are five new, real, nullable `QueueEntry` columns** — `examDescription`,
`contrastRequired`, `patientSex` (`PatientSex`, a new closed three-value enum, not free
text), `patientWeightKg`, `preparationNotes` — plus the pre-existing `scheduledAt`, all
editable through one `PATCH /queue/:id`. This directly closes a gap `nursing`'s own i18n
docstring had explicitly flagged as deferred when the quick-action feature shipped ("None of
this exists on `QueueEntry` ... considered and explicitly deferred rather than invented for
this pass"). `UpdateQueueEntryDetailsRequestSchema` uses the same "key omitted = leave alone,
explicit `null` = clear" convention `UpdateEquipmentRequestSchema` already established, with
a `superRefine` rejecting a genuinely empty patch (otherwise a no-op PATCH would still write
an audit row documenting nothing). The audit row for this route (`QUEUE_ENTRY_UPDATED`)
carries `changedFields` — field *names* only, never the values — since weight/sex/notes are
clinical data and the audit table must not become a second, less-protected copy of it;
verified in `queue-exam-details.e2e.spec.ts` by asserting the audit details object has
exactly two keys (`equipmentId`, `changedFields`) and neither the submitted weight, sex, nor
note text appears anywhere in it.

**Editable while `WAITING` or `IN_PROGRESS`; locked at `DONE`/`CANCELLED`**
(`QueueEntry.assertDetailsEditable`) — deliberately more permissive than the preparation
quick-actions' own "requires an open slot" rule (which excludes `IN_PROGRESS` for
positioning/injecting): correcting a patient's recorded weight while their exam is already
running is a real, legitimate action; editing it after the visit is finished would rewrite
history rather than record it.

**`PreparationStatus`'s own docstring needed a correction, not just an addition.** It used to
justify `INJECTED` being skippable with "`QueueEntry` has no contrast/exam-type field" — false
as of this feature. The *domain* transition stays permissive on purpose even now that
`contrastRequired` exists (an aborted contrast exam still has to release the patient
regardless of whether contrast was ever actually due) — what changed is only the nurse's own
UI, which hides the "Injetado" button entirely when `contrastRequired` is false, rather than
the handler rejecting the transition server-side.

**No drag-and-drop library added — this repo has none, by design (see `ConsoleShell`'s own
docstring on hand-building over pulling in a component library).** The `↑`/`↓` `<button>`s
are the canonical, keyboard/screen-reader-operable mechanism (an `aria-live="polite"` region
announces every move, e.g. "Maria movida para a posição 1 de 3"); native HTML5
`draggable`/`onDragStart`/`onDragOver`/`onDrop` is layered on top for pointer users, not a
replacement for the buttons. The reorder banner is driven by a real dirty-state comparison
between the client's draft order and the server's own current order
(`isReorderDirty`/`arraysEqual` in `queue-display.ts`) — not the source prototype's
fabricated "AGUARDANDO VALIDAÇÃO" second-approval stage, which has no equivalent anywhere in
this codebase: "Confirmar Nova Sequência" *is* the commit.

**A live push mid-edit does not clobber an unconfirmed draft, on either feature.** If
`QUEUE_UPDATED`/`PATIENT_PREPARATION_UPDATED` arrives while a reorder draft is dirty, or
while the exam-details form has unsaved changes, `NursingPage` shows a "the queue/this
patient changed elsewhere" notice with an explicit reload action instead of silently
overwriting what the nurse was in the middle of typing or dragging — see the `staleQueueNotice`/
`detailsStaleNotice` state and their own comments in `NursingPage.tsx`.

**Not reproduced from the source prototype, each for a specific, existing reason** (same
policy as every prior feature built from a mock — see `adminClinics`'s/`nursing`'s own
docstrings above for the precedent):

| Prototype element | Why not |
|---|---|
| Pedido Médico / Questionário PDF uploads, "Revisar"/"Substituir" | No file storage or PHI-safe upload path anywhere in this repo *at the time this table was written* -- both now exist (`ChatAttachmentStorageService`, then `QueueEntryDocument`/`QueueDocumentStorageService` -- see "Uploading the exam-order document itself" below), on a Railway volume so they persist. Kept here as the historical record of this task's own narrower scope, not as a current claim |
| Full name, prontuário (`#TR-84931`), CNS number | Only `patientFirstName` is stored, on purpose (PHI minimization, see the queue module's own long-standing rule) |
| Console Remoto, "Falar c/ Operador", "Áudio da Sala TC", the operator chat log | No voice/intercom channel and no chat feature exist anywhere in this codebase — the one real clinic↔operator channel is `SessionPage`'s own audited "Type text" (`PRINT_TEXT`) |
| Trilha de Auditoria panel on this screen | The audit rows this would show are real, but `NURSING` is deliberately outside `AuditController`'s own `@Roles` — adding read access here would be a permissions change, not a UI reproduction, and isn't part of this task's two business rules |
| "AGUARDANDO VALIDAÇÃO" second-approval badge on the reorder banner | No approval/review model exists anywhere; "Confirmar Nova Sequência" is the one and only commit step |
| Free-text "+ Adicionar Tag" protocol chips | This codebase prefers closed enums (`PatientSex`, `ExamModality`, ...) over open, typed-string taxonomies — see `ExamModality`'s own docstring for the same reasoning |
| "Iodado: ~85ml" derived contrast-dose figure | `patientWeightKg × 1.3` happens to match the prototype's own numbers, but rendering a dosing calculation is a clinical claim this project has no basis to make; the field stores weight and whether contrast is required, and stops there |
| "(Horário ajustado)" auto-adjusting the scheduled time on reorder | Queue priority and appointment time are independent facts on this entity; reordering never touches `scheduledAt` — the nurse edits it explicitly, the same as every other exam-detail field |

**Known limitation, recorded rather than silently accepted**: reordering has no true
optimistic lock (no `version` column). Two nurses reordering the same room at the exact same
moment: the loser's stale full-set permutation check fails loudly with a 409 rather than
silently applying a wrong order, but there is no compare-and-swap guarantee beyond that.
Acceptable for this pass — the same tradeoff the rest of this codebase already makes
everywhere it doesn't have an explicit version/etag column.

### A11y suite update: the four pre-existing failures this feature's own verification pass re-diagnosed

The note directly above this section blamed `ForcePasswordChangePage`/"Admin users
page"/"Activate account page"/"Session page and replay page" on `nest build` failing because
of an in-progress, uncommitted "nursing lock banner" feature
(`SessionParticipantNameService`/`summarizeDisplayNames`). **That specific cause no longer
exists** — both are implemented and `nest build` now succeeds cleanly and repeatably (checked
directly, repeatedly, while verifying this feature). Re-running the full a11y suite during
this feature's own verification pass found the same four test names still fail, but re-traced
each to its own real, current, and still entirely unrelated-to-this-feature cause rather than
assuming the old explanation still applied:

- **`ForcePasswordChangePage`**: `POST /users` with `role: "OPERATOR"` from a `CLINIC_ADMIN`
  actor now 400s. `ROLE_GRANTS[CLINIC_ADMIN]` is `[NURSING]` only (see the multi-clinic
  membership feature's own docstring above) — a real capability removal from *before* this
  feature that this one test never got updated for. The test's premise (a Clinic Manager can
  create an Operator account to demonstrate a forced password change) is simply no longer
  true anywhere in this app.
- **"Admin users page"**: times out waiting for `getByRole("heading", { name: "Usuários" })`
  — because `AdminUsersPage` has no `<h1>` at all (only an internal `<h2>` for its create-user
  section), unlike every sibling `ConsoleShell` page (`AdminEquipmentPage`, `AdminUnitsPage`,
  `AdminClinicsPage` each render their own `<h1>`). A real, pre-existing `page-has-heading-one`
  violation this specific assertion just never had occasion to surface before.
- **"Activate account page"**: fails only as a *downstream* consequence of the point above —
  it reads `lastInvitedEmail`, a module-level variable this same file's "Admin users page"
  test is supposed to set before ever reaching the invitation step it never gets to.
- **"Session page and replay page"**: timing-dependent on `PiKvmHealthPoller` having already
  marked the seeded equipment `ONLINE` against the mock PiKVM server, exactly as the test's
  own comment already says — a matter of how the local demo stack happened to be sequenced
  during this verification pass (which PiKVM host the seed script was pointed at, and how
  long the poller had run before this test executed), not a code defect.

`DashboardPage` has the identical missing-`<h1>` gap as `AdminUsersPage` (confirmed directly:
`grep -n "<h1" apps/web/src/pages/DashboardPage.tsx` matches nothing) — its own a11y test
fails the same `page-has-heading-one` rule for the same reason. Neither this nor the
`ROLE_GRANTS` regression above is fixed in this pass: both are pre-existing, unrelated to
either of this feature's two business rules (queue reorder, editable exam details), and
fixing either risks its own unbudgeted ripple (adding `DashboardPage`/`AdminUsersPage`'s own
`<h1>` needs an a11y pass across whatever else assumed the current heading structure;
loosening `ROLE_GRANTS` is a real permissions decision, not a queue-feature concern) —
recorded here so the next task that touches either doesn't have to re-discover it from
scratch, the same reasoning this file's own preceding note already established for
`SessionParticipantNameService`.

## Nursing: the day's patient queue (main screen)

A third task on the same role, built from a *different* source prototype than the previous
two — the full "Fila da Sala 1, Tomografia" day screen rather than the quick-action or
reorder views. The brief was "main screen of the Nursing profile showing the day's patient
queue", and the honest starting point was that roughly two-thirds of that screen's
*behaviour* already existed here (preparation quick-actions, reorder, editable exam details,
lock/operator awareness, live push); what was missing was mostly **layout** plus a handful of
genuinely new data.

**"Today" needed a definition, and defining it exposed a real bug in the previous task's own
work.** `GET /queue` gained an optional `?date=YYYY-MM-DD`; `clinicDayBounds` turns that into
a `[gte, lt)` UTC instant range for one calendar day in the clinic's configured timezone
(`CLINIC_TIME_ZONE`, default `America/Sao_Paulo`). Before this, `NursingPage`'s exam-detail
form wrote a nurse's typed time as a *bare UTC instant*
(`new Date(\`${today}T${time}:00.000Z\`)`) and read it back the same way, while a separate
formatter on the same page rendered preparation timestamps in the *browser's* local zone.
That was self-consistent only by accident — nothing before this feature ever compared a
`scheduledAt` against a server-computed day boundary, so an 08:00 exam stored as `08:00Z`
never visibly contradicted anything. It would have, immediately, the moment "N Pacientes
Hoje" started filtering on it. `packages/shared/src/clinic-day.ts` is now the single source
of truth both sides call (`clinicTimeToUtcIso` to write, `formatClinicTime` to read,
`clinicDayBounds`/`todayClinicDayString` to scope), with a dedicated test asserting the
round-trip *and* asserting the old construction differs from the correct one by exactly the
zone's offset — the bug pinned down as a test, not just fixed.

**One configured timezone, not a per-clinic column.** This app is pt-BR-only and every
seeded clinic is Brazilian; a `Tenant.timezone` column would be a schema + admin-form change
in service of a deployment shape that doesn't exist yet. `apps/api` reads the real env value
and passes it explicitly into every `clinic-day.ts` function; `apps/web` has no server env to
read and uses the same module's `DEFAULT_CLINIC_TIME_ZONE`. Both land on the same zone in
practice, but through one implementation rather than two. Also worth naming: Brazil abolished
DST nationally in 2019, so the configured zone is a fixed UTC-3 year-round today, which is
what makes `zonedWallClockToUtc`'s single-offset-lookup exact rather than approximate — the
function's own docstring records that it would be off by at most one DST jump, right at a
transition instant, for a zone that does observe one. Not reached today; recorded rather than
silently assumed.

**`?date=` is optional and never defaulted to "today" server-side.** `DashboardPage`'s own
patient-queue table and `StartSessionHandler`'s "find the next WAITING patient" flow both
call `GET /queue` with no `date` at all and need every entry regardless of day. A "today"
default would have silently broken both. Only `NursingPage` passes it, computed client-side.
The nullable-`scheduledAt` case is handled explicitly in the Prisma `where`
(`OR: [{ scheduledAt: in-range }, { scheduledAt: null, createdAt: in-range }]`) so an entry
added today with no scheduled time still appears today instead of vanishing from every day's
view — the kind of thing that would otherwise only surface as "why is the queue empty".

**The safety questionnaire is what the *previous* task explicitly deferred.** The earlier
`nursing` i18n docstring said triage/allergies/contrast data "does not exist on `QueueEntry`
... considered and explicitly deferred rather than invented for this pass". This pass built
it, as real columns: `fastingConfirmed`/`fastingHours`, `creatinineMgDl`, `allergyStatus`
(a new closed two-value enum) + `allergyNotes`, and `contrastVolumeMl`. Recorded and
displayed as entered; **nothing derives a clinical decision from any of them**. The single
derived thing anywhere is the "Alerta Jejum" card chip (`queueCardChipOf`), computed from
`fastingConfirmed` + `contrastRequired` — a workflow reminder on a card, which gates no
action, server-side or client-side. The alternative considered and rejected was blocking
"Paciente Posicionado" until the questionnaire was complete: that would be the app making a
clinical go/no-go call, which is a different kind of decision than displaying a chip.

**Contrast volume stayed nurse-entered, reinforcing rather than reversing the previous task's
call.** The mock shows "Dose Est.: ~102 ml (1,5ml/kg)" — and 68 kg × 1.5 does equal 102, so
it is trivially computable. `contrastVolumeMl` records what the exam's own protocol
specifies, as the nurse enters it; the platform never multiplies a weight into a dose.
Rendering a mL figure derived from patient weight is a clinical-dosing claim this project has
no basis to make, which was the previous task's reasoning too — the mock showing it a second
time, with its formula, didn't change that.

**`creatinineMgDl` is a `Float`, deliberately, and this is the first non-`Int` numeric in the
schema.** Introducing Prisma `Decimal` means introducing Decimal.js conversion at the
repository boundary for every future numeric too. The value is recorded and displayed only —
never used in arithmetic anywhere — so a `Float` rendered at fixed precision is adequate and
honest. Documented in the schema itself so it doesn't read as an accident.

**The timeline panel is a resource-scoped route, not a widening of audit access.**
`GET /queue/:id/timeline` lives on `QueueController` (which `NURSING` already reaches) rather
than relaxing `AuditController`'s own `@Roles` (which deliberately excludes `NURSING`, and
still does). It is tenant-checked through the existing `belongsToTenant`, filtered to
`resourceType: "QueueEntry"` plus that one `resourceId`, has actor names resolved, and
carries **none** of the hash-chain fields (`seq`/`hash`/`prevHash`) a real audit reviewer
needs but a bedside panel has no business exposing. `queue-timeline.e2e.spec.ts` asserts both
halves of that in one test: `NURSING` gets `200` here and `403` from `GET /audit` in the same
breath — two genuinely independent gates, not one relaxed rule. This required
`ListAuditLogsFilter` to gain `resourceType`/`resourceId` (the columns existed and were
already returned; there was simply no way to filter by them) and `AuditModule` to export
`AUDIT_REPOSITORY`.

**A `QUEUE_REORDERED` row never appears in a per-patient timeline**, because that action is
audited under the *equipment's* id — a room-level act, decided in the previous task. That
matches the mock's own per-exam framing, and is asserted as a test rather than left to look
like a gap.

**`GET /auth/me` is new, and self-scoped by construction.** The header renders the signed-in
nurse's own name and registration ("Fernanda Alves · COREN-SP 148209"), which nothing could
supply before: `professionalRegistration` exists and is plumbed all over the app, but the JWT
carries only `sub`/`tenantId`/`role`/`clientOs`, and `GET /users/:id` is
`PLATFORM_ADMIN`/`CLINIC_ADMIN`/`OPERATOR_ADMIN` only — `NURSING` is not in that list and
shouldn't be, since that route can look up *any* user in the tenant. The new route has no
`@Roles` gate at all, deliberately: it reads `AccessTokenClaims.sub` and nothing else, so it
can only ever answer "who am I", never "who is user X". No new authorization surface exists
for any role. `SessionState` gained `operatorRegistration` alongside its existing
`operatorName` for the same reason on the operator's side (the "Operador Remoto" card's
"CRBM 4289"), resolved in the same batched lookup — and `operatorName`, which shipped
untested two tasks ago, finally has a test covering it.

**Read-only by default gates the record, not the clinical act.** The mock shows padlocked
fields *alongside* an active "Paciente Posicionado" button, which is exactly right: editing a
patient's recorded weight and asserting that they are physically positioned on the table are
different kinds of action. "Habilitar Edição" unlocks the exam-detail `<fieldset>` only; the
preparation quick-actions are never gated by it. A successful save returns to read-only,
matching the mock's own per-card workflow.

**A bug found only by driving the real screen in a browser.** The timeline panel's
`useEffect` depended on `selectedEntryId` alone, so a nurse's own just-saved edit — which
writes a `QUEUE_ENTRY_UPDATED` audit row — didn't appear in the panel until she clicked a
different patient and back. No type check, contract test, or e2e test would have caught it:
every layer was individually correct. Fixed with a `timelineNonce` bumped after any action
that writes a row for the selected entry (a details save, a preparation quick-action), and
re-verified live for both paths. Worth recording as the third instance in this project of the
same lesson — `pnpm dev`'s broken Vite dev server, the stale `.vite` pre-bundle, and now this
— that a passing build and a green test suite say nothing about whether a screen actually
works when a human uses it.

**Not reproduced from this pass's own source mock**, each for a specific existing reason (the
same policy applied to every prior mock-driven feature — see `adminClinics`'s and `nursing`'s
own i18n docstrings for the precedent):

| Prototype element | Why not |
|---|---|
| Chat Operacional do Exame, Canal de Áudio ("Falar c/ Operador" PTT, "Voz no Gantry"), Segurança da Sala (porta blindada / clima do gantry / parada de emergência) | No messaging, audio, or sensor-telemetry transport exists anywhere in this codebase. Replaced with a real per-exam audit timeline and the actual operator identity — similar information shape, no fabricated transport |
| Pedido Médico Digital and Questionário PDFs ("Visualizar Pedido", "Revisar Respostas", "Assinado Digitalmente") | No file storage of any kind *at the time this table was written* -- uploading the document itself is now real (`QueueEntryDocument`, see "Uploading the exam-order document itself" below); "Assinado Digitalmente" (ICP-Brasil signature verification) is still refused, for a reason that no longer has anything to do with file storage not existing -- this platform has no basis to perform real PKI chain verification |
| "Dose Est.: ~102 ml (1,5ml/kg)" | See above — recorded, never computed |
| "Macros Rápidas de Sala" (CONT / PL / TB / INT / PSM) | Needs the chat channel above to land anywhere honest. Mapping them onto `PRINT_TEXT` would type "PSM Pronto Para Escanear" into the scanner's own clinical application, which is almost certainly not the intent |
| Free-text "+ Adicionar Tag" observation chips | This repo prefers closed enums over open typed-string taxonomies (see `ExamModality`'s own docstring) |
| Age / date of birth, full name, prontuário `#TR-84920`, CNS number | Only `patientFirstName` is stored, by deliberate PHI minimization — unchanged across all three nursing tasks |
| Horizontal top nav (Cockpit / Exames / Enfermagem / Supervisão / Equipamentos), "Intercorrência" / "Parada Emergencial" | `ConsoleShell`'s sidebar is this app's real chrome. The one real emergency control (`release-all`) already lives on `SessionPage`, for the Biomédico Operador actually driving the equipment — the nurse in the room has no equivalent action to trigger |
| A date picker / browsing previous days | Out of scope for this pass: "the day's queue" means today's. Browsing other days is a real, separate follow-up — the API already supports it (`?date=` takes any day), only the UI doesn't offer it |

**Still open, unchanged from the previous task's own note**: the two missing `<h1>`s on
`DashboardPage`/`AdminUsersPage` (and the Activate-account test that fails downstream of the
latter), plus the `ROLE_GRANTS` regression that breaks `ForcePasswordChangePage`'s own a11y
test. All four are pre-existing, unrelated to any of the three nursing tasks, and remain
deliberately out of scope — re-confirmed rather than re-diagnosed this pass.

## The Biomédico Operador's workstation-selection screen

The brief: "Biomedical profile entry screen for selecting the work location. Fields: Unit
(dropdown) and Room (dropdown). The 'Confirm' button directs the user to the Exam Screen for
the selected room." Built from a "Selecione seu Perfil e Posto de Trabalho" RadLink mock, and
landed as `/posto-de-trabalho` (`WorkstationPage.tsx`) — `OPERATOR`'s new post-login home
(`role-routes.ts`), gated the same way every other role-specific route already is (`RoleRoute`
in `App.tsx`).

Two things the mock implied that this codebase's existing invariants ruled out before any UI
work started:

- **The three "profile" cards aren't a picker.** Role comes from the JWT and is enforced by
  every controller's own `@Roles` — no client-side choice could ever be honest here, since
  the backend would reject a role the account doesn't actually have. `UserRole.OPERATOR` is
  already "Operador Biomédico" (`pt-BR.ts`'s `roles` namespace, predating this feature). The
  card became read-only: `IdentityCard` + `RolePermissionSummary`, the same two components
  the password-reset screens already use for "who is this and what can they do" — no new
  component needed.
- **There is no `Room` model to query.** A room is `Equipment.roomLabel` (see the equipment
  registry section above and `units.ts`'s own `roomCount` docstring) — `NursingPage` already
  established equipment-as-room. The Room dropdown is `GET /equipment` filtered to the chosen
  `unitId`, client-side, exactly like `NursingPage`'s own room picker. `GET /units` and
  `GET /equipment` are both already open to any authenticated role (reads are tenant-scoped
  inside the handler, not behind `@Roles`) — this feature needed **zero backend or
  `@crop/shared` changes**.

**What the mock showed that has no real backing, and what replaced it**: the topbar's "VPN
Segura: 14ms" pill and the equipment card's "Link Ativo (Fibra Redundante)" / "Latência: 16ms"
are all invented — no VPN-tunnel or per-equipment link-latency measurement exists anywhere in
this codebase (`use-latency` measures in-session WHEP round-trip time, a different thing
entirely). Dropped, the same policy every prior mock-sourced feature in this file has applied.
What *is* real and kept: the equipment's own health-poller status (`displayStatusOf`,
`badgeClassOf`, `statusLabelKeyOf` — reused as-is from `equipment-display.ts`, not
reimplemented) and the room's actual today's-queue count (`GET /queue?equipmentId=&date=`,
the same call `NursingPage` makes). The mock's "ETAPA 1 DE 2" stepper is also gone — this
screen has exactly one job, there is no real second step to number.

**Where "Confirm" actually goes.** There is no dedicated exam screen yet — the closest real
thing `OPERATOR` has is `DashboardPage`, which already shows one room's queue and starts
sessions. Rather than invent a placeholder page that would just be `DashboardPage` again with
a different name, `DashboardPage` gained a scoped mode: `?equipmentId=` (set by Confirm)
filters the fetch to that one room instead of the tenant's whole fleet — a real reduction in
per-equipment queue requests, not just a client-side view filter — and renders a small
`.room-header` context strip with a "Trocar posto de trabalho" link back. Everything else
about `DashboardPage` (English text, its own dark-theme choices) is untouched; the strip is a
deliberate small pt-BR island on an otherwise still-English page, the same seam the "Manage
users" button already documents elsewhere in this file. When a real, dedicated exam screen
exists, only this one destination changes — `WorkstationPage` itself doesn't need to know.

Explicitly **not** part of this task, flagged rather than silently absorbed: the clinic
role-grant/units-CRUD change discussed alongside it (`CLINIC_ADMIN` granting every clinic
role, `LOCAL_SUPERVISOR` granting `NURSING`/`LOCAL_IT`, and `LOCAL_SUPERVISOR` joining units
CRUD) is a real, separate change to `ROLE_GRANTS`/`UnitsController`'s `@Roles`, not something
this screen's own scope touches. *(Since done -- see the next section, which took it on
together with the role-model inversion it turned out to depend on.)*

## Reversing the role model: operators belong to the operating company

The business model, stated plainly for the first time: the platform admin registers clinics
and operating companies; a clinic contracts one or more operating companies; an operating
company serves one or more clinics; the clinic's own nursing staff own everything
patient-related, and the *operating company's* staff run the exams remotely. A clinic has no
operators of its own.

That last sentence is what broke the existing role model. `ROLE_TENANT_TYPES` allowed
`OPERATOR`/`OPERATIONAL_SUPERVISOR`/`OPERATOR_ADMIN` in a `CLINIC` tenant, deliberately and
for a documented reason (see the superseded section earlier in this file): `Equipment`,
`Session` and `QueueEntry` are single-tenant-scoped at 30 `belongsToTenant` call sites, so
co-tenancy was the *only* way an operator could actually reach a scanner. The seed encoded it
-- `operator@alpha.crop.health` lived inside Clinica Alpha.

An operator employed by the clinic it remotely operates is a contradiction in the model above:
there is nobody to contract with. So the invariant was inverted -- those three roles are now
`OPERATOR_PROVIDER`-only -- and the cross-tenant problem was solved properly instead of
worked around.

**How the 30 single-tenant checks survived untouched.** A contracted operator now *switches
into the clinic's context*: `SwitchActiveClinicHandler` mints a token whose `tenantId` claim is
the clinic, which that handler's own docstring already promised would keep "every existing
`belongsToTenant` check working unmodified". Tenancy stays the coarse check; the contract is
the fine one. The alternative -- keeping the provider tenant in the JWT and threading a
contract-aware authorization argument through equipment, queue, sessions and audit -- would
have rewritten those 30 call sites and forced the chat/realtime fan-out off the existing
`tenant:<id>` Socket.io room. It buys better audit attribution, and it is the right eventual
shape, but it is a much larger change than the one the business rule actually required.

**Two real bugs this surfaced, both pre-existing.** Neither was caused by the inversion; both
were latent while every caller's home tenant happened to be a clinic:

- `ListMyClinicsHandler` (`GET /auth/me/clinics`, which backs the clinic switcher) never
  included operator-linked clinics. `AdminUnitsPage`'s own docstring had already noticed and
  named this -- "a pre-existing gap this page inherits rather than fixes" -- so an
  `OPERATOR_ADMIN` whose access came only through the operator link saw units for a clinic
  that was absent from their own clinic list, and the page rendered a raw tenant id where a
  name belonged. It also meant the *authorization* answer disagreed with itself:
  `ClinicAccessChecker` had allowed the operator link since it was written, while
  `SwitchActiveClinicHandler` required a `UserClinicMembership` row -- so an operator could be
  authorized to see a clinic's units yet unable to obtain a token scoped to that clinic to do
  it with. Both now accept the same two links.
- The same handler added the caller's home tenant to the clinic list unconditionally, with no
  check that it *is* a clinic. Harmless before; now it would have offered an operator their own
  employer as a clinic to switch into, which `SwitchActiveClinicHandler` would then correctly
  refuse -- a picker entry guaranteed to fail.

**The migration keeps one provider per clinic, on purpose.** `20261002090000_operator_provider_role_split`
moves every operator-side account out of its `CLINIC` tenant, but it does *not* pool them into
one shared operating company: access is granted per (clinic -> operator tenant) link, so a
shared provider would have made every migrated operator reachable into every migrated clinic.
That is a privilege escalation invented by a migration. Giving each affected clinic its own
provider reproduces the pre-migration topology exactly. The migration also asserts its own
postcondition (`RAISE EXCEPTION` if any operator-side user is left outside an
`OPERATOR_PROVIDER` tenant) rather than trusting the `UPDATE`s to have matched everything --
verified by replaying it against a fixture of the old topology on a scratch database, including
that the assertion actually fires when an account is stranded, and that a second run is a no-op.

**The test suite was testing an impossible topology.** 25 of 33 e2e specs built operators inside
clinic tenants, and every one of them kept passing after the inversion -- because
`createLoggedInUser` writes users with `prisma.user.create`, bypassing `RegisterUserHandler` and
therefore `isRoleAllowedInTenantType` entirely. Tests passing against data the product cannot
produce are worse than tests failing: this fixture is used mostly to probe cross-tenant
authorization, which is precisely what the fake topology made unrepresentative. So the fixture
now asserts the invariant itself, and a new `createContractedOperator` helper performs the real
four-step path (provider tenant -> operator link -> account in the provider -> `POST
/auth/active-clinic`). Step four is a genuine HTTP round trip, not a hand-forged token, so every
operator spec now exercises the cross-tenant authorization path and would fail if it regressed.

**Two behaviours that changed meaning, both now pinned by their own tests.** Deactivating a
clinic used to lock out the people who operate it, purely because they shared a tenant. Those
are now separate facts: a contracted operator's *account* keeps working (they are employed
elsewhere and serve other clinics) while their *access to that clinic* is cut, since
`SwitchActiveClinicHandler` refuses a deactivated clinic. And identity events like
`LOGIN_FAILURE` are audited against the acting user's home tenant -- for an operator, the
operating company -- while what they do to a clinic's equipment is audited against the clinic.
A consolidated cross-tenant view for an operator admin is real, known, outstanding work; it is
flagged here rather than left to be discovered from a confusing empty audit page.

**Permissions, corrected in the same pass.** `CLINIC_ADMIN` now grants every clinic role
(including another `CLINIC_ADMIN` -- the one self-granting edge in the matrix, so a clinic can
appoint a second manager without calling the platform operator) and `LOCAL_SUPERVISOR` grants
`NURSING`/`LOCAL_IT` but never a peer or a manager. Widening `ROLE_GRANTS` alone would have been
inert: `UsersController`'s class-level `@Roles` rejects the request before any grant check runs,
so `LOCAL_SUPERVISOR` had to be added there too. Conversely `OPERATOR_ADMIN` *lost* equipment
and unit CRUD: a scanner belongs to the clinic that owns it, and an operating company reaches it
to read and operate, never to provision. `role-capabilities.ts` follows -- its
`user_management_nursing` key became `user_management_clinic` plus a distinct
`user_management_clinic_staff`, because collapsing them into one key would have made that
display-only list claim a supervisor can appoint managers.

**What this phase deliberately did not build.** `Tenant.operatorTenantId` is still a single
nullable self-FK, so today a clinic has at most one operating company. The business rule is
many-to-many in both directions, which needs a join entity (`OperatorAgreement`) plus the
propose/accept handshake and the per-unit/per-equipment grants that make a contract mean
something narrower than "all of this clinic". That is the next phase; this one deliberately
kept the existing column, because it is enough to carry the role inversion without also
inventing an authorization model in the same change. `ClinicAccessChecker` is the seam it will
be built on, which is why the units-access spec now asserts both that an operator's write is
refused *and* that its read still resolves -- a 403 on the write alone cannot distinguish the
role gate doing its job from the operator link having silently broken.

*(Done — see the next section, which replaced the column with `OperatorAgreement` exactly as
described here, and built on `ClinicAccessChecker` as predicted.)*

## The clinic↔operator contract: replacing a column with an agreement

Phase 1 moved operators into their own tenants and left them reaching a clinic through
`Tenant.operatorTenantId` — a nullable self-FK. That column was always a placeholder, and it was
wrong in three separate ways, each of which is a feature this section adds:

- **It could express one operating company per clinic.** The rule is many-to-many in both
  directions: a clinic contracts several companies, a company serves several clinics.
- **It had no handshake.** A `PLATFORM_ADMIN` set it unilaterally. Nobody agreed to anything.
- **It was all-or-nothing.** Linked meant "operate this entire clinic". There was no way to say a
  company may drive the MRI in one wing but not the CT in another.

`OperatorAgreement` + `OperatorAgreementScope` replace it. The column is dropped in
`20261003090000_operator_agreements`.

**Scope denies by default, and the migration had to prove that was safe.** An agreement with no
scope rows grants nothing. The tempting alternative — "empty means everything" — would have made the
dangerous reading the permanent default, so instead the conversion writes *real* grants: one
unit-level row per existing unit of every previously-linked clinic. Unit-level, not
equipment-level, because that is what the old link actually meant: equipment installed into an
already-trusted room later stays covered. Equipment with `unitId IS NULL` (legal, and therefore
unreachable through a unit grant) gets its own row — missing that would have silently revoked
access to exactly those devices. The migration then asserts both properties before dropping the
column: link count equals ACTIVE agreement count, and no converted agreement ended up scopeless
while its clinic had anything to grant. Verified by replaying it against a fixture of the Phase 1
topology on a scratch database, including a linked clinic with no units at all (which must *not*
trip the second assertion) and a unit-less scanner (which must survive).

**`homeTenantId`: the claim that made scope enforceable at all.** Phase 1's choice — a contracted
operator switches into the clinic's context so all ~30 `belongsToTenant` checks keep working — has a
consequence that only bites once scope exists. After the switch, `tenantId` *is* the clinic, so
tenancy can no longer distinguish the clinic's own staff from an outside company operating it: both
present the same value. `AccessTokenClaims` therefore gained `homeTenantId`, the tenant the account
actually belongs to. `OperatorAccessService` reads the two: equal means "owns the data, tenancy
already settled it"; different means "an agreement must justify this, and its scope must name this
device". Optional on the claim, because tokens minted before it existed must still verify — and
absent reads as *not* cross-tenant, which is safe rather than permissive, since the only way to hold
a clinic's `tenantId` under the old flow was to belong to that clinic. The alternative, loading the
user on every equipment read to find their home tenant, would have put a query in front of the
hottest path in the product and made the access service depend on `IamModule`, which depends on it.

**Where scope is enforced, and why it is not 30 places.** `GetEquipmentQuery` is the choke point that
matters: `StartSessionHandler` loads equipment through it, so gating that one handler stops an
out-of-scope session without the sessions module learning anything about agreements. `ListEquipment`
*filters* rather than refusing — an operator whose contract covers one of three rooms should see one
room, not an error — while the single-resource path throws, because there the caller named something
specific and deserves to be told which of "no contract" or "out of scope" applies. The queue needed
its own five call sites: it loads a `QueueEntry` and never the device, and it returns patient first
names, which makes it the highest-value leak in the API. `OperatorAccessService.assertCanReachEquipmentId`
exists for exactly those callers, reading equipment through Prisma directly — the same
one-directional choice `PrismaUnitRepository` already documents — so five handlers did not each have
to inject the equipment repository to run an authorization check.

**A module split that is load-bearing, not tidiness.** `AccessModule` holds the agreement repository
and `OperatorAccessService`; `AgreementsModule` holds the commands and the HTTP surface. They are
separate because `AgreementsModule` has a controller and therefore needs `IamModule`'s guards, while
`IamModule` needs agreement reads for `SwitchActiveClinicHandler` and `ListMyClinicsHandler`. Iam →
Agreements → Iam is unresolvable except with a `forwardRef`, which hides a cycle rather than removing
one. `AccessModule` depends on nothing but Prisma, so every edge into it stays one-directional.

**Invariants on the entity, not in the handlers.** "Only the side that did not propose may answer",
"only an active agreement can be revoked", "scope is the clinic's to set" all live on
`OperatorAgreement` as assertion methods. The third is the one asymmetry in an otherwise two-sided
model and it is the whole point of scope existing: the operating company is the party being limited,
so letting it widen its own grant would make the limit decorative. Revocation, by contrast, is
deliberately unilateral — requiring the counterparty's consent to *stop* would mean a clinic could be
held to an operator it no longer trusts.

**Two things revocation deliberately does not do.** It does not invalidate tokens: enforcement lives
on the data paths, so an operator holding a clinic-scoped token issued a second earlier reaches
nothing through it — asserted in `operator-agreements.e2e.spec.ts` using the *old* token on purpose.
And it does not force-end running sessions. Killing a session mid-scan because a contract lapsed
would be a clinical-safety hazard; the clinic's own "End session" control already exists for the case
where they want it stopped now.

**Re-proposing reuses the row.** One agreement per `(clinic, operator)` pair, moved back to PENDING
rather than inserted again, with the previous round's answer cleared so a reopened agreement cannot
look already-accepted. That keeps "has this company ever been contracted here" answerable from one
place, and keeps scope rows stable across a renegotiation. The cost is that the row's own history
lives in `audit_logs` rather than as a transition table — consistent with how every other lifecycle
in this schema records its past.

**Audit attribution is always the clinic**, even for the acts the operating company performs. The
clinic is the party whose data exposure changes, and its own log is where a reviewer looks to answer
"who could see our patients, and since when". So `AGREEMENT_REVOKED` carries `revokedByClinic` in
`details`: `revokedByUserId` alone cannot say which side walked away, and the two mean very different
things. `TENANT_OPERATOR_LINKED` is kept in the `AuditAction` enum and never emitted again —
`audit_logs` is append-only by DB trigger, so historical rows referencing it must stay readable.

**One screen for both sides.** `AgreementsPage` serves the clinic and the operating company from one
route, because it is one relationship and `GET /agreements` already answers from either direction;
two pages would have duplicated the list, the status vocabulary and the propose flow to express a
difference the API does not make. Accept/Reject render only for the side that may actually use them,
mirroring `assertCanBeRespondedToBy` — the same "don't offer an action the API will refuse" lesson
`SessionPage`'s own "End session" button documents having learned once. Scope editing offers units
only: per-equipment grants exist in the model and the API honours them, but asking a clinic admin to
reason about two overlapping granularities in one form buys little, and the unit grant is the one that
keeps covering a room as its scanners are replaced.

**What is deliberately still missing**: emailing a counterparty when a contract is proposed (the
pending row in the list *is* the notification; a clinic's `institutionalEmail` is nullable and there
is no contracts-recipient role, so inventing a delivery target would silently drop half of them); an
accept-by-link flow for someone without an account (accepting changes who may reach patient data, so
it must be an authenticated, audited act by a named admin); and the consolidated cross-tenant audit
view an `OPERATOR_ADMIN` needs to see session history across its client clinics — session rows land
under each clinic, which is correct, and reading across them is a real, still-open piece of work.

## Contract-scoped clinic selection: giving the switch a frontend, and what that exposed

Phase 2 built the whole agreement model -- propose/accept, per-unit/per-equipment scope,
enforcement on every equipment/queue/session read -- entirely from the backend down. Nothing in
`apps/web` had ever called `POST /auth/active-clinic`; `AdminUnitsPage`/`AdminUsersPage`'s own
multi-clinic support worked by passing an explicit `clinicTenantId` *parameter* to endpoints that
accept one, which equipment/queue/sessions never have. So an operator's actual clinic->unit->
equipment cascade (rule #11) had a real backend and no way to reach it.

**`WorkstationPage` gained a real clinic step, and it is never skippable for `OPERATOR`.** Since
the role-model inversion, this role's home tenant is always an `OPERATOR_PROVIDER`, which owns no
clinic of its own -- there is no default to fall back to the way a clinic-side role falls back to
its own home tenant. The step is `GET /auth/me/clinics` (agreement-derived since Phase 2) into a
picker; selecting one calls the new `useAuth().switchActiveClinic` (a real token mint, the same
"already authenticated, get a fresh pair" shape `changePassword` already had) before `GET
/units`/`GET /equipment` run at all. Selection lives in the URL (`?clinicTenantId=&unitId=&
equipmentId=`) like every other filter in this app, and returning here (a reload, or
`DashboardPage`'s "Trocar posto de trabalho" link) seeds the clinic step from whichever clinic the
stored token is already scoped to, rather than forcing a re-pick of a clinic never actually left.

**`DashboardPage` needed the identical fix, for a reason that was not this task's original ask.**
`OPERATOR_ADMIN`/`OPERATIONAL_SUPERVISOR` land on `DashboardPage`, and their home tenant also owns
no equipment now -- without a way to switch clinics from *there*, their actual landing page showed
"No equipment registered" permanently, with no path forward. This was a regression the role-model
inversion introduced two phases ago that stayed invisible until a frontend switcher existed to
reveal it. Fixed with the same primitive: a clinic picker that renders only when there is a real
choice to make (`myClinics.length > 1`, or the active tenant isn't a clinic on the list at all) --
never for the ordinary single-clinic case, and, as a side effect, finally giving a genuinely
multi-clinic `CLINIC_ADMIN` (`gestor.multi@crop.health`) a working way to see a second clinic's
equipment from this page at all, which nothing in the UI had ever offered before.

**A socket bug both pages shared, only latent until switching existed.** `createSessionSocket()`
snapshots the access token at connect time; `SessionsGateway.handleConnection` joins that socket to
one tenant room for the life of the connection. Both pages used to open their socket once, on
mount, with an empty effect-dependency array -- harmless while the active tenant never changed
during a page's lifetime, and silently wrong the instant it could: a socket opened before a switch
stays deaf to `QUEUE_UPDATED`/`EQUIPMENT_STATUS_CHANGED` for the clinic actually being worked in,
forever. Both effects are now keyed on `user?.tenantId` and reconnect on every switch.

**The real bug this phase's own live-browser verification found: `OperatorAccessService` had been
narrowing the wrong callers all along.** `isCrossTenantActor` originally read only `homeTenantId
!== tenantId` -- true whenever *any* caller has switched away from their home tenant, for any
reason. That is also true of a plain multi-clinic `CLINIC_ADMIN` switching between two clinics they
hold a genuine `UserClinicMembership` row for, a relationship with no `OperatorAgreement` anywhere
near it (none is possible between two `CLINIC` tenants). Every equipment/unit read Phase 2 gated
therefore came back **empty** for such a manager the instant they switched -- and none of Phase 2's
262 backend tests caught it, because none of them combined a membership-based switch with a live
equipment read through the full stack; the gap was only reachable once a real frontend switcher
existed to drive it, which is exactly what this phase built. Found by the Playwright run against
`gestor.multi@crop.health`, not by review. Fixed by also requiring the caller's *role* to be one
`ROLE_TENANT_TYPES` confines to `OPERATOR_PROVIDER` tenants (`OPERATOR`/`OPERATIONAL_SUPERVISOR`/
`OPERATOR_ADMIN`) -- the only roles that can ever have an agreement on the other end of a switch --
and pinned with a new assertion in `clinic-membership.e2e.spec.ts` that a switched-in manager sees
the target clinic's equipment in full. `AUDITOR` is deliberately left out of that role check even
though it can be OPERATOR_PROVIDER-homed too (see roles.ts): fixing it precisely needs the home
tenant's actual *type*, which is exactly the per-call lookup this service exists to avoid on
equipment's hottest read path. Narrower, one-sided (an auditor seeing more than the operators it
audits, not an unauthorized party seeing anything), and unexercised by any seed data -- flagged in
the method's own docstring rather than silently accepted or fixed by adding the lookup back.

**A second real gap the same verification pass found, this time in Phase 2's own equipment
scoping.** `GET /units` was never scope-filtered at all -- only `GET /equipment` was. A contracted
operator whose agreement named one room could still see every *other* room's name and existence in
the unit dropdown, just with an empty equipment list once selected. Closed with
`OperatorAccessService.filterReachableUnits`/`assertCanReachUnit`, which count a unit as reachable
if it is granted directly *or* contains at least one equipment-level grant (a real, separate scope
shape `SetAgreementScopeRequestSchema` already allowed: naming one scanner without naming its whole
room) -- resolved via a new `resolveEquipmentUnitIds` lookup on the agreement repository, the same
one-directional "read the other module's table directly, don't import it" choice
`PrismaUnitRepository`/`resolveScopeTargets` already established, rather than a new
UnitsModule<->EquipmentModule dependency.

## The exam cockpit: `ExamPage`, real chat, push-to-talk presence, and the operator's own notes

The three prior phases built the business model (agreements, roles, clinic-switching) and left
`SessionPage` as the operator's only console -- a bare video mirror plus HID input, unchanged since
the very first pass. This phase built the actual remote-support cockpit a second RadLink prototype
showed: one equipment per screen, the drivable console still at its center, but now flanked by a
real room camera panel, exam-support chat, push-to-talk presence, quick-reply shortcuts, and a
patient-info panel -- at `/exame?equipmentId=`, reached from `WorkstationPage`'s "Confirmar e Acessar
Sala" (the only navigation call this phase changed; `DashboardPage`'s own "Start/Rejoin session"
buttons for every other role still go to `SessionPage`, untouched).

**Three real, persisted features, not fabricated telemetry.** The prototype's own "Chat Operacional
do Exame" and "Canal de Áudio (PTT)" panels are exactly the kind of thing two earlier nursing passes
already declined to build for lack of any messaging/audio transport (see the "not built" list
below, now finally out of date for one of its two halves) -- so this phase built the missing half
rather than reproducing the mock with fabricated data:

- **`ExamMessage`** -- a real, persisted text channel tied to the *equipment* (the room), not to
  any one session: a note left before an exam starts should still be visible to whoever joins next,
  and `queueEntryId` is stamped opportunistically from the room's current patient at send time so a
  transcript can later be filtered to one exam without that being the only way to reach it. Sending
  is WebSocket-only (`EXAM_MESSAGE_SEND`/`EXAM_MESSAGE_CREATED`, broadcast to the whole session room
  including the sender, so no optimistic client-side append is needed); reading the initial
  transcript and managing shortcuts is REST (`ChatController`, `@Roles` mirroring `QueueController`'s
  own broad clinic/operator set). Text only -- no attachments, no audio message type; both explicitly
  out of scope at the time (see "The room-chat rework" below for attachments arriving later, and
  "Uploading the exam-order document itself" for the medical-order PDF upload this paragraph's own
  cross-reference used to point at before either existed).
- **`IntercomChannel` push-to-talk presence** -- signalling only, never audio: holding
  `INTERCOM_PTT_SET` broadcasts "I am speaking on `PATIENT`/`TECHNICIAN`" to the room and produces
  exactly one audited row (`AuditAction.INTERCOM_PTT`, carrying the held duration) when released,
  not a media pipeline. Real two-way audio needs a WHIP/WHEP path `infra/mediamtx/mediamtx.yml`
  doesn't have (configured for one-way room video only) and a room-speaker/gantry integration this
  codebase has never had -- see the enum's own docstring. Presence lives in a new
  `InMemoryIntercomPresenceRegistry` (`IntercomPresencePort`), the same "runtime state, not a
  database row" choice the existing controller/takeover registry already made for who holds the
  keyboard.
- **`MessageShortcut`** -- real, persisted, per-clinic-tenant quick-reply phrases (`CONT`, `PL`,
  `TB`, `INT`, `TL`, `PSM` seeded as defaults for every existing clinic by this phase's own
  migration), not the prototype's free-text "+ Adicionar Tag" chips -- this codebase prefers a
  closed, administrable set over an open typed-string taxonomy, the same rule `ExamModality`'s own
  docstring already states. Clicking a chip inserts its body into the composer rather than sending
  immediately, so it is still a starting point the operator can edit, not a one-tap send.

**A fourth, smaller real feature: the operator's own procedural note.** `QueueEntry.teleoperationNotes`
is a second free-text field alongside the nurse's existing `preparationNotes` -- distinct columns,
distinct write paths (`PATCH /queue/:id/teleoperation-notes`, `@Roles` limited to the operator-side
roles exactly the way the nurse's own exam-details PATCH is limited to clinic-side roles), because
"what the nurse prepared" and "what the remote operator observed during the exam" are different
facts with different authors and no reason to share one column. Editable under the identical
`WAITING`/`IN_PROGRESS` rule `QueueEntry.assertDetailsEditable` already enforces for the nurse's own
fields (`assertTeleoperationNotesEditable`, and the frontend's `isDetailsEditable` reused verbatim
rather than re-declared a second time), and rendered from `ExamPage`'s own patient-info modal
alongside the read-only fields nursing already collected -- PHI minimization unchanged: only fields
this platform actually stores, no name/DOB/prontuário expansion.

**Why `/exame` is equipment-scoped, not session-scoped, and does not replace `SessionPage` as a
route.** The operator's real workflow is "this room, whichever exam is running or about to be," not
"this one session id" -- `ExamPage` itself decides whether to join an already-active session or
render its own "Iniciar Exame" prompt (mirroring `DashboardPage`'s existing `nextPatient` pick), and
when `SESSION_ENDED` arrives it clears local state and reverts to that same prompt for the *next*
patient rather than navigating away. `SessionPage` stays exactly what it always was -- the generic
per-session console any participant/supervisor can reach by session id, e.g. `DashboardPage`'s own
"Rejoin session" link used by every clinic-oversight role -- untouched, because nothing about this
phase's business rules concern those other roles' own workflows.

**Two real bugs found and fixed while writing this phase's own backend tests, both in code this
phase itself just wrote (see this file's own established habit of separating "found in old code"
from "found in new code" -- both worth recording, differently).** `IntercomPresencePort.clearHolder`
originally took no `userId` -- any participant could force-release someone else's held channel, the
inverse of `HID_INPUT`'s own controller check but for a feature this phase deliberately left
uncontroller-gated (see `onIntercomPttSet`'s own comment on why talking to the patient isn't "driving
the equipment"). Fixed by requiring the caller's own id and only releasing a hold that matches it,
pinned by a dedicated test asserting a different participant's release attempt is silently ignored.
Second: `SessionsGateway.handleDisconnect` awaited the HID safety-net release *before* reaching the
new push-to-talk cleanup below it -- harmless when PiKVM answers quickly, but PiKVM's own HTTP client
can take its full multi-second request timeout to give up on an unreachable device, during which a
crashed tab's held channel stayed shown as held for however long that unrelated call was hanging.
Fixed by running the two independent safety nets concurrently (`Promise.all`) rather than one after
the other; found by a disconnect test that started failing with an *empty* audit-row array, not an
error, once the (deliberately generous) mock-PiKVM timeout genuinely dwarfed the test's own wait.

### A11y suite verification: five more issues this feature's own pass found, one of them an environment gotcha rather than a code bug

Re-running the full a11y suite against a freshly `make demo-reset` database (this feature's own
verification, the same house habit the queue-reorder feature's section above established) found
five more things, none of them this feature's two new business rules (`ExamMessage`/`IntercomChannel`
presence) themselves:

- **`DashboardPage`/`AdminUsersPage` really did have no `<h1>` at all**, exactly as the queue-reorder
  feature's own note above already found and *deliberately left unfixed* at the time, citing
  "unbudgeted ripple." This phase needed both pages' own a11y tests passing to trust its *own* two
  new `ExamPage` tests running in the same file, so both finally got the one-line
  `<h1 className="visually-hidden">` every sibling `ConsoleShell` page already has -- low-risk
  enough (a single element, an existing convention, no layout change) that deferring it a third time
  no longer made sense.
- **`WorkstationPage`'s clinic-auto-select assumption doesn't hold for `operator@central` any more.**
  `GET /auth/me/clinics`'s `active` flag is `tenant.id === callerToken.tenantId` -- always false on a
  fresh login, since a token's initial tenant is always the operator's *home* (provider) tenant,
  never a clinic. `WorkstationPage`'s own auto-select only fires when `active` is already true, so
  it has only ever worked for a *returning* operator who already switched once, not a fresh login --
  and since Phase 2 gave `operator@central` agreements with *two* clinics (Alpha and Beta, not one),
  there is a real choice here regardless, matching `DashboardPage`'s own "only show a picker when
  there is a real choice" rule. The existing a11y test never picked a clinic at all before this
  phase, which means it had been silently relying on a single-clinic auto-select that stopped
  existing back when Phase 2's own agreement seed introduced Operadora Central's second clinic --
  simply never re-run since. Fixed in the test, not in `WorkstationPage`: requiring an explicit pick
  when a real choice exists is correct, not a bug.
- **The migration-backfilled "Unidade Principal" default doesn't exist on a modern `make demo-reset`.**
  That backfill only ever ran against clinic tenants that already existed *at migration-apply time*
  -- on a freshly reset database, `prisma migrate deploy` runs before the seed script creates any
  clinic at all, so the backfill's own `INSERT ... SELECT FROM tenants WHERE type = 'CLINIC'` finds
  nothing to act on. The a11y test that exercised `WorkstationPage`'s "unit with no equipment" empty
  state relied on that unit existing for free; fixed by having the test create its own throwaway
  unit via the API instead, and then *also* extending Operadora Central's own agreement scope to
  cover it (`PUT /agreements/:id/scope`) -- a plain "create a unit" is not enough on its own, since
  agreement scope is deny-by-default and creating a unit grants no one access to it.
- **A genuine environment gotcha, not a code bug: Vite's dependency pre-bundle cache for
  `@crop/shared` can go stale relative to that package's own rebuilt `dist/`.** A long-running
  `pnpm --filter @crop/web dev` process (exactly the kind this project's own demo stack keeps up for
  days at a time) pre-bundles workspace packages once and caches the result under
  `node_modules/.vite/deps/`; rebuilding `@crop/shared`'s `dist/` afterward (e.g. adding
  `IntercomChannel`, as this phase did) does not by itself invalidate that cache. The symptom was a
  runtime crash -- `Cannot read properties of undefined (reading 'PATIENT')` -- with `ExamPage`'s own
  source completely correct and `@crop/shared`'s own built output completely correct too; only
  clearing `apps/web/node_modules/.vite` and restarting the dev server fixed it. Worth knowing for
  the next feature that adds a new export to `@crop/shared` while a demo stack has been running
  since before that change.
- **`ForcePasswordChangePage`'s own a11y test is broken by a second, later regression the
  queue-reorder feature's note above did not yet know about.** That earlier note traced the test's
  failure to `ROLE_GRANTS[CLINIC_ADMIN]` no longer including `OPERATOR` and stopped there, correctly
  for its own time. `CreateUserRequestSchema` has *also* since dropped its `password` field entirely
  (user creation is invitation-link-only now, per `AdminUsersPage`'s own docstring) and made
  `clinicTenantIds` required for any role that needs one -- so swapping the test's target role to
  `NURSING` (this phase's own attempted fix, matching the earlier note's own diagnosis) still 400s,
  on a request shape that predates the invitation flow by an entire feature. Left broken and
  unrepaired: fixing it for real means rebuilding this one test around the invitation-and-activate
  flow `AdminUsersPage`'s own test already exercises, not a role swap, and that rewrite is not this
  phase's own business rule to own. Recorded here, the same "so the next task that touches this
  doesn't have to re-discover it from scratch" reasoning this file already uses for every other
  known-and-deferred item.

## Nursing: an exam-data overlay while a patient is "Awaiting Positioning"

A fourth task on the same role, plus `LOCAL_SUPERVISOR` this time, built from a *fourth*
source prototype -- not another nursing mock, but the Teleoperação cockpit's own "Dados do
Exame · Paciente em Preparação" panel. The brief named a status ("Awaiting Positioning")
that does not exist as a distinct value anywhere in this codebase, and a data block
("Physician's Order") with zero backing data. Both got resolved the same way every prior
ambiguity from a screenshot has: map onto what is real, or say plainly why not, never invent
either the state or the record.

**"Awaiting Positioning" is `PreparationStatus.NOT_STARTED`, not a new enum member.**
`VALID_PREPARATION_TRANSITIONS` (`queue-entry.entity.ts`) only ever moves a patient *out of*
`NOT_STARTED`, never back into it -- so "hasn't been positioned yet" and "NOT_STARTED" are
the same fact under two names, not two states that happen to overlap today. A fifth
`PreparationStatus` value would have meant a Prisma migration, a new transition rule, and a
second contract accepting it, all to distinguish a state from itself. Instead
`isAwaitingPositioning` (`queue-display.ts`) names the existing check
(`NOT_STARTED` + `WAITING`/`IN_PROGRESS`) for its one real call site, and the overlay's own
`awaitingPositioningBadge` string carries the prototype's exact wording as *display* text
only -- `nursing:prepNotStarted` ("Não iniciado"), the queue strip's own label for the same
value, is untouched.

**The overlay is anchored to one card, not the screen.** `ExamDataOverlay` covers only
`NursingPage`'s existing "Detalhes do Exame" card (`.nursing-details-wrap`, a `position:
relative` wrapper around just that card), never the room header, the queue strip above it,
or the "Ações Rápidas" prep buttons below it. Two things made that the only workable choice
rather than a stylistic one. First, the nurse's own way to *resolve* "Awaiting Positioning"
is the "Paciente Posicionado" button in that same prep-actions panel -- an overlay that
covered it would block the one action that clears the state that opened it. Second, the
overlay's content is a read-only summary of the exact card it sits over, so hiding that card
while it's shown loses nothing. `role="region"`, not `role="dialog"`: it never traps focus,
never autofocuses, and has no Escape handler, matching the source mock's own non-modal
panel (its chat and queue rail stay usable behind it) -- collapsing it is a deliberate click
on the chevron, the only thing that dismisses it.

**Selecting *any* patient card collapses the overlay, discovered by cross-checking against
the a11y test rather than by inspection.** The overlay's visibility is derived from
`currentPatientOf(queue)` -- the room's current patient -- entirely independent of
`selectedEntryId`, which is whichever card the nurse clicked to inspect. Before this fix,
clicking the *current* patient's own card to open "Habilitar Edição" left the overlay
sitting on top of the very form the click was supposed to reveal (it only ever re-collapsed
on an *identity* change of the current patient, e.g. after a real "Posicionado" click moved
the room on to someone else); clicking a *different* patient's card left the current
patient's overlay floating over that other patient's unrelated details. `selectEntryForEditing`
now collapses the overlay unconditionally on every explicit selection -- correct for both
cases, since either way the nurse just asked to see a details card the overlay must not be
sitting on top of.

**Every field renders even when empty, the deliberate opposite of `ExamPage`'s own
patient-info modal.** That modal (`<dl className="patient-info-list">`) omits an empty field
outright -- it is a teleoperation aid the operator opens on demand, so absence usually just
means the nurse hasn't recorded that fact yet. This overlay exists specifically to be read
*before* the scan, so a missing weight or an unconfirmed fasting status has to be visible as
an explicit "Não informado", not indistinguishable from a field that was simply never in the
prototype's own layout.

**Not reproduced, added to `NursingPage`'s own table for the same reasons its neighbors
weren't:** the prototype's digital Pedido Médico (physician name/CRM, an ICP-Brasil
signature, "Visualizar Pedido") -- no file storage or physician/order record existed anywhere
in this schema *at the time*, the same reason the day-view task's own questionnaire PDFs were
refused. Uploading the document itself is a real, separate feature that *was* later built --
see "Uploading the exam-order document itself" below -- but the physician-name/CRM extraction
and the ICP-Brasil signature verification specifically are refused for a different reason now:
nothing in this app parses a PDF's contents, and nothing here can perform real PKI chain
verification. The computed "Dose: 1,25
ml/kg" / "Volume: 85 ml (350mgI)" -- the same nurse-entered-not-computed `contrastVolumeMl`
decision every nursing task on this screen has made; "Idade: 54a" -- only `patientFirstName`
and `patientSex` are ever known, by the same PHI-minimization posture as every other pass;
and the invented protocol code "TC-TORAX-02" -- no procedure-code taxonomy exists,
`examDescription` is the one free-text field that already carries this.

No backend change of any kind: every field the overlay shows was already on `QueueEntryDto`
from the day-view task. This is the first nursing-role pass with zero Prisma migration,
contract change, or new endpoint.

A found (not introduced) a11y bug, caught by the axe scan rather than by review: the
overlay's two section headings were `<h4>`, skipping a level past the surrounding "Detalhes
do Exame" card's own `<h2>`/`<h3>` -- `heading-order` failed the moment the panel was
actually open in a browser. Fixed to `<h3>`, matching the exam-details form's own
`questionnaireHeading` heading one card over. Recorded because it's exactly the kind of
error `tsc`/lint cannot catch and only the a11y tier (browser + axe-core, not just JSX) is
positioned to.

## Migrating to shadcn/ui: two real bugs, not just a redesign

Two independent user-reported bugs, both traced to root causes rather than patched at the
symptom, kicked off a full shadcn/ui (Radix + Tailwind v4) migration that is ongoing as of
this entry: "typing into the 'Novo Exame' modal loses focus on every keystroke" and "I don't
have a way to edit the patient info" (a screenshot of the Nursing page's exam-data overlay
covering its own "Habilitar Edição" button). Both are now fixed, structurally, alongside the
first two phases of the migration -- foundation + primitives, then a full rebuild of the
Nursing screen. The remaining phases (auth, shell, admin tables, forms, the teleoperation
suite) are tracked but not yet done; this entry covers what's real so far.

**The focus bug: an effect keyed to an inline arrow function's identity, fixed once in
`Modal.tsx`, not per call site.** The old hand-rolled `Modal` trapped focus in a `useEffect`
depending on `[onClose, returnFocusTo]`. Every one of the 9 call sites passed `onClose` as
an inline arrow (`onClose={() => setOpen(false)}`), which gets a new identity on every
render -- so typing a single character anywhere inside any modal re-rendered the owning
page, which re-created `onClose`, which re-ran the effect: the cleanup fired first
(yanking focus to the trigger button outside the dialog), then the effect body re-ran
(parking focus back on the dialog's own container). One keystroke, focus thrown out and
back, every time. Rebuilding `Modal` on Radix's `Dialog` fixes this structurally: Radix's
own focus trap is keyed to the *content*'s mount/unmount, never to a prop's identity, so no
call site needed to change at all -- the same 9 usages, unmodified, stopped losing focus the
moment `Modal.tsx` itself did.

**A real, transitional theme bug the rebuild introduced and then had to fix.** The old
`Modal` always wrapped its content in `.theme-light` regardless of the page underneath, so
every modal's still-old-stylesheet body (most of them, until their own page's migration
phase) rendered correctly light-on-white. The new `Modal` (shadcn's `DialogContent`) dropped
that wrapper, and the old `.field`/`<input>` rules read CSS custom properties that default
*dark* at `:root` -- so every unmigrated modal briefly rendered dark-on-dark the instant this
landed, caught by literally looking at a screenshot, not by any test. Fixed by keeping
`className="theme-light"` on `DialogContent` (with an inline `style={{ minHeight: 0 }}`
override -- `.theme-light` also sets `min-height: 100vh`, correct for a full-page root,
catastrophic on a centered dialog box that inherited it as an *unlayered* rule beating every
Tailwind utility regardless of specificity). Removed once nothing in the app depends on the
old stylesheet at all.

**A second, unrelated animation-timing bug the a11y tier itself caught.** Radix's `Dialog`
animates open over ~200ms (`tw-animate-css`'s `animate-in`/`fade-in-0`/`zoom-in-95`). The
existing "Recovery page" a11y test scans the confirmation dialog the instant
`dialog.waitFor()` resolves -- which can be mid-transition, and axe correctly flagged a
"color-contrast" violation against the genuinely-lower-contrast, still-fading-in frame it
sampled. Fixed for the right reason, not just to quiet the test: `index.css` now has a real
`@media (prefers-reduced-motion: reduce)` rule (a WCAG 2.3.3 best practice `tw-animate-css`
doesn't provide on its own), and the a11y spec's own `beforeEach` calls
`page.emulateMedia({ reducedMotion: "reduce" })` to trigger it -- the *context option*
(`use: { reducedMotion: "reduce" }` in `playwright.config.ts`) was tried first and, confirmed
by direct comparison rather than assumption, does not reliably flip `matchMedia` in this
Playwright/Chromium combination. One a11y test assertion also had to change honestly, not
just get patched to pass: `toBeFocused()` on the dialog *container* became
`dialog.locator(":focus")` being visible, because Radix's own default initial-focus target
(the first focusable descendant -- the WAI-ARIA APG dialog pattern's own recommendation) is a
real improvement over the old implementation's "focus the container", not a regression to
paper over.

**The nursing exam-data overlay was hiding its own edit button -- the actual bug report.**
`ExamDataOverlay` (added in the previous entry) shared a CSS grid cell with the "Detalhes do
Exame" card so it could visually cover that card without affecting page layout. Its own
collapsed header -- roughly 70px tall -- landed exactly on the card's `.page-head` row,
which is where "Habilitar Edição" lived. The button wasn't *broken*; it was *unreachable*,
sitting directly underneath an opaque panel. Fixed by deleting the overlay concept
entirely: the "Detalhes do Exame" card now has exactly one render branch per state
(`editMode`), toggling between a read-only summary (what the overlay used to show) and the
existing editable form (what the card always showed) -- there is no longer a second surface
that can cover the first, so this class of bug is now structurally impossible, not just
fixed in this one instance. `isAwaitingPositioning`'s own predicate is unchanged; only its
one caller moved from a separate component's visibility check into an effect that
auto-selects that patient into the (now singular) details card, once per room, only if the
nurse hasn't already picked a different patient to look at herself.

**Badge/pill colors are the *same* hex values the old stylesheet used, not new ones.** The
old `.badge.queue-waiting`/`.prep-positioned`/`.allergy-present`/etc. rules are "self-
contained pills (own bg + fg), not dependent on the surrounding theme" -- already measured
against WCAG AA (>= 6.1:1) independent of light/dark. The new Tailwind `Badge` usages carry
the identical hex pairs as arbitrary-value classes (`bg-[#3d1d1d] text-[#ff8b8b]`, etc.)
specifically so the visual language and its contrast guarantees survive the migration
unchanged, rather than a fresh (unverified) palette choice.

**The nursing screen's own layout bug, pre-existing and unrelated to any of the above, fixed
in the same pass because it was blocking a screenshot.** `.session-layout`'s grid
(`3fr 1fr`, no `min-width` on either track) let the queue strip's `flex: 0 0 220px` cards
force the left column to its full min-content width -- four cards' worth, well past 900px --
shoving the right column ("Operador Remoto"/timeline) off-screen at any realistic viewport
width. `minmax(0, 3fr) minmax(0, 1fr)` lets both tracks shrink below their content's natural
size, so `.queue-strip`'s own `overflow-x: auto` (already there) does its job instead of the
grid container just growing past the viewport. Shared by `SessionPage`/`ExamPage` too, so
this one CSS change repairs all three.

**Standardizing on one light theme, not two.** Before this migration, `:root` held today's
dark palette and `.theme-light` was an opt-in override a handful of pages/components used
(`ConsoleShell`, `LoginPage`, `RecoveryPage`, the old `Modal`) -- a real, if narrow, two-theme
split. `index.css`'s new token layer is unconditionally light, seeded 1:1 from
`.theme-light`'s own already-contrast-verified values (see that block's own comment for the
measured ratios) rather than an unverified fresh palette. This matches every RadLink
prototype this app has ever been built from, which were always light-themed -- the dark
`:root` was this app's own placeholder default, never a deliberate design target.

**`shadcn`'s own CLI convention differs from its documented `components.json`**, discovered
rather than assumed: generated primitives import `cn` from a real, shadcn-org-maintained npm
package (`cn`, a compiled clsx+tailwind-merge replacement) rather than a generated local
`src/lib/utils.ts`, even though `components.json`'s `aliases.utils` still points at
`@/lib/utils`. Rather than keep two competing `cn()` implementations in the tree, the
hand-written `utils.ts` this project started with was deleted in favor of the package every
generated file already uses.

**`next-themes` (a shadcn-generated dependency of `sonner`'s own `Toaster`) was removed, not
kept unused.** `Toaster`'s default reads `useTheme()` and falls back to `"system"` outside
any `ThemeProvider` -- which this single-theme app was never going to mount -- meaning
`Sonner` would resolve the *OS's* own dark-mode preference for toast styling alone,
contradicting the one light palette every other surface in the app enforces. Hardcoded to
`theme="light"` instead, and the dependency dropped entirely rather than left installed and
inert.

## Migrating to shadcn/ui, continued: the auth cluster, and a systemic CSS layering bug

Phase 3 of the shadcn migration (see the previous entry for Phases 0-2): `Logo`, `AuthCard`,
`PasswordField`, `PasswordStrength`, `PasswordPolicyChecklist`, `Stepper`, `IdentityCard`,
`ExpiryCountdown`, `QrCode`, `SetPasswordForm`, and the four pages that compose them
(`LoginPage`, `RecoveryPage`, `ActivateAccountPage`, `ForcePasswordChangePage`) are now on
Tailwind/shadcn. `RecoveryPage`'s hand-rolled tab strip (manual `role="tab"`, `aria-selected`,
arrow-key handling) is now shadcn's `Tabs` (Radix) -- the primitive does what that custom
`Tab` component used to do by hand, including the roving-focus keyboard behavior the a11y
test already exercised.

**A systemic bug, not a per-page one: two old, unlayered, app-wide element selectors
(`a { color }`, and briefly `body { color/background }`) kept beating Tailwind on every
migrated page, for the same underlying CSS Cascade Layers reason documented in the previous
entry for `.theme-light`.** Unlike that earlier, scoped case, `a { color: var(--color-accent)
}` in `styles.css` targets *every anchor in the app*, unconditionally -- so as soon as any
migrated page styled a link with Tailwind's `text-primary`, axe caught the old rule still
winning (a "Voltar para o login" link measuring 2.23:1 against a white card, using the old
dark-theme's light-blue accent, `#6fb1ff`, meant for a dark background). This was not a
one-off: it would have silently broken *every link on every future migrated page* the same
way, since nothing about the bug is specific to `RecoveryPage`.

Fixed with a small, deliberate CSS Cascade Layers trick: `index.css` now opens with
`@layer legacy;` *before* `@import "tailwindcss"`, pre-registering that layer name first in
the whole cascade's ordering (layer priority is decided by where each name is *first seen*;
once `@layer theme, base, components, utilities;` -- which Tailwind's own `@import` emits --
has run, a new layer introduced later, e.g. by `styles.css`, can only be *appended after* it,
at the *highest*-priority end, the opposite of what's needed). With `legacy` pre-registered
lowest, wrapping the old `a` rule in `@layer legacy { a { color: ... } }` in `styles.css`
makes it lose to *every* Tailwind utility, on any element that has one, while an unmigrated
page's own links -- nothing there competes for that property -- render exactly as before.

**The same trick, tried on `body`'s own `color`/`background`, made things worse instead of
better, and was reverted.** The original, narrower problem it was meant to fix: `AuthCard`'s
`<h1>`/tagline sit directly in `<main>`, outside the light `Card`, so with no closer ancestor
setting a color they inherited `body`'s own old dark-theme text -- readable (dark-on-dark is
still self-consistent), but visibly the wrong theme surrounding a now-light card. Wrapping
`body`'s rule in `@layer legacy` too, so `index.css`'s own `@layer base { body { @apply
bg-background text-foreground } }` would win instead, looked like the same fix as `a` --
except `a`'s fix only changes *priority* on elements that already have a *competing*
Tailwind utility (i.e., ones this migration actually touched), while replacing `body`'s
*default* changes the *inherited fallback* for literally every page, migrated or not. The
very next full-suite run caught it immediately: `ExamPage`'s still-untouched `.queue-card`
(old dark background, no color of its own, relying on inheriting `body`'s old dark text)
turned into unreadable dark-on-dark text, at 1.15:1. Reverted; `AuthCard` instead gets its
own explicit `bg-background text-foreground` on its own `<main>`, exactly the same way its
old `.theme-light` wrapper used to own that scope, rather than depending on `body`'s cascade
at all. The general lesson recorded here for the phases still ahead: a *priority-only* fix
(wrapping an old rule that only wins where nothing competes yet) is safe to apply broadly;
a *replacement* fix (introducing a new unconditional default) has to be scoped to exactly
the subtree that needs it, checked by running the full a11y suite after every such change,
not assumed safe by analogy to a previous fix that happened to be the first kind.

**A second, unrelated margin-collapse bug the very next screenshot caught.** `AuthCard`'s
`<main>` had no padding of its own; its first child carried `mt-16` for the logo's own top
spacing. A child's top margin collapses through a parent with no border/padding/content
between them and the parent's own edge, so `<main>`'s own background rect started 64px
*below* the viewport's top edge (confirmed via `getBoundingClientRect()`, not guessed) --
`min-h-screen` guarantees a *minimum height from wherever the box starts*, not that the box
starts at the viewport's own top, so the collapsed margin left a 64px strip of `body`'s dark
background showing above an otherwise fully light page. Fixed by moving the spacing onto
`<main>` itself as `pt-16` (padding never collapses) and dropping the child's own margin.

**`TabsTrigger`'s own shadcn default text color for an inactive tab -- `text-foreground/60`,
switching to the fully-opaque `text-muted-foreground` only in dark mode -- fails this app's
own light palette.** At this app's `--muted` shade, 60%-opacity foreground measured 3.81:1
against it, short of the 4.5:1 WCAG AA needs (caught by axe on `RecoveryPage`, not assumed).
Edited directly in the generated `ui/tabs.tsx` (legitimate here, the same as `sonner.tsx`'s
own edit in the previous entry) to use `text-muted-foreground` unconditionally -- this app
has exactly one theme, already contrast-verified at that exact pairing.

## Migrating to shadcn/ui, continued: `ConsoleShell`

The highest-blast-radius single file in this whole migration -- every page that renders
inside it (`DashboardPage`, `AdminUsersPage`, `AdminEquipmentPage`, `AdminUnitsPage`,
`AdminClinicsPage`, `NursingPage`, `AgreementsPage`, and their form pages) inherits whatever
this file does, migrated or not. Rebuilt on Tailwind/shadcn (`Button`, `lucide-react`'s
`Zap`/`Bell` replacing the `⚡`/`🔔` emoji) with the exact same content and behavior.

**The same class of bug the previous two entries already found, a third time, in a third
place -- and this time caught before it shipped, by checking a screenshot before moving on
rather than after.** The natural first draft put `bg-background text-foreground` on the
whole shell's outermost wrapper div, the same way `AuthCard`'s `<main>` needed it. But that
wrapper also contains `<main className="page">{children}</main>` -- and `children` is
*whatever page is active*, most of which are still on the old stylesheet with old dark
`.card` backgrounds, relying on inheriting `body`'s own dark text to stay readable. Claiming
`text-foreground` on a shared ancestor of both the (migrated) chrome and the (not yet
migrated) page content applies the new color to *both*, and `DashboardPage`'s equipment
cards immediately washed out into unreadable dark-on-dark (1.15:1, confirmed by screenshot
before writing this down, not assumed). Fixed by moving `bg-sidebar`/`bg-card` (already
correct) plus `text-foreground` onto `<aside>` and `<header>` *directly* -- the two elements
actually migrated -- and removing both from the shared wrapper entirely, so `<main>`'s own
inherited color still falls through to `body` untouched for whichever not-yet-migrated page
is rendering inside it.

**The general pattern, now seen three times (`.theme-light`, `body`, `ConsoleShell`'s own
wrapper) is worth naming plainly for whatever page migrates next:** a *shared ancestor* of
migrated and not-yet-migrated content must never claim a *replacement* color for the whole
subtree it wraps. Only the elements that are *themselves* actually migrated may claim one,
each directly on itself -- never on something both migrated and unmigrated content sit
inside. Checked, each time, by taking a real screenshot of an *unmigrated* page reached
through whatever changed, not just the migrated one the change was actually about.

## Migrating to shadcn/ui, continued: Dashboard, Audit, Clinic home

`AuditPage` and `ClinicHomePage` (both standalone, no `ConsoleShell`) and `DashboardPage`
(the largest of the three, `ConsoleShell`-based) are now on Tailwind/shadcn -- `Table` for
the audit log and each room's patient queue, `Select` for the clinic picker, `Badge` for
equipment status (`ONLINE`/`OFFLINE`/`DEGRADED`/`MAINTENANCE`, same hex pairs as the old
`.badge.online`/etc., carried over rather than re-picked). `RolePermissionSummary` is
deliberately *not* migrated in this pass -- its only two callers, `WorkstationPage` and
`AdminUsersPage`, are both still on the old stylesheet, so migrating the component now would
float a light card on a still-dark page; it moves when they do.

**A fourth instance of the same "shared ancestor" bug, this time on a case the earlier fix
deliberately couldn't cover.** `ConsoleShell`'s `<main className="page">` still carries no
background of its own -- by design, per the previous entry's own rule. That's correct for
*text color*, but it leaves a real, if purely cosmetic, seam: a fully-migrated page's own
`Card`s render correctly (white, self-contained), but any *empty space* around them --
gaps between cards, space below short content on a tall viewport -- still shows through to
`body`'s own dark background, since nothing between `<main>` and `body` claims one either.
Tried the obvious fix (`bg-background` on `<main>` itself) and reverted it before it landed
anywhere: `AdminEquipmentPage`/`AdminUnitsPage`/`AdminClinicsPage`/`AgreementsPage` all have
a bare `<h1>`/`<p>` sitting directly in `<main>` with no `Card` of their own, inheriting
`body`'s old light text color -- a light `<main>` background would have made all four
illegible instantly. Left as a known, accepted, temporary rough edge: no text ever sits in
that empty space, so it produces no contrast violation, only an inconsistent-looking gap
that resolves itself once the four pages above are migrated too and `<main>` can finally
claim `bg-background` safely.

**A fifth instance, caught by the a11y test rather than reasoned out in advance: two
elements on the now-mostly-light `DashboardPage` still float directly in that same
unclaimed `<main>`, and picked up this app's new (light-theme) accent/muted colors instead
of the old dark-compatible ones.** The "Audit log" button and the two "no equipment" empty-
state messages aren't inside any `Card`/`Alert` -- axe measured the button's `text-primary`
at 3.25:1 against the still-dark backdrop it actually sits on. Fixed by reverting exactly
those two spots to the old theme's own mechanism (`.link-button`'s class, `var(--color-
muted)` inline) rather than Tailwind's new tokens -- correct precisely *because* they are
not inside a relit `Card`, unlike every other link/muted text on the same page, which is.
The general rule this adds to the previous entry's own: a *fully migrated* page can still
have individual floating (non-`Card`) elements that need the *old* theme's colors, if
`<main>` itself is still unclaimed -- check every non-`Card` text node on a migrated page
against its *actual* rendered backdrop, not just the page's own overall migration status.

## Migrating to shadcn/ui, continued: the admin-table cluster and `AgreementsPage`

`RolePermissionSummary` moved to `Card` in step with `AdminUsersPage` (its other caller,
`WorkstationPage`, stays on the old stylesheet for now -- the same "moves when they do"
call as the previous entry, just resolved for one caller and not the other; a temporary
cosmetic inconsistency, not a bug). `AdminUsersPage`, `AdminEquipmentPage`, `AdminUnitsPage`,
`AdminClinicsPage` and `AgreementsPage` are now all on `Table`/`Select`/`Badge`/`Card`, each
inside its own `Card` (filters in one, the listing in another, matching every other admin
page rather than floating a bare `<table>` in `<main>` the way the old stylesheet did).
Native `<select>`s became Radix `Select`s throughout, which needed a sentinel value for
"no filter selected" since `Select.Item` rejects an empty-string `value`: `ALL` in the three
admin-registry pages and in `AgreementsPage`, `UNSET` in `NursingPage` (Phase 2) -- mapped
to/from `null`/`""` at the read/write boundary in each case, never sent to the API as the
literal sentinel string.

**A guessed color, wrong in the same direction three times.** The old stylesheet's
"success"/"active" green, `#3a9d5f`, was carried into the first Tailwind pass verbatim on
the assumption that a hex value copied from working CSS must still pass contrast -- it
doesn't (3.4:1 on white, needs 4.5:1) once it's foreground text on a plain white `Card`
rather than a dark badge chip with its own tinted background. Caught by the a11y test on
`AdminUsersPage` first, then found by inspection in the same two other spots it had been
pasted (`NursingPage`, `AuditPage`) and fixed to `#166534` (green-800, 7.13:1) in all three
before it could fail a fourth time. The badge-chip green, `#5fdc8a` on `#1d3d2b`, is a
different, still-correct pair -- it was never in danger, precisely because it keeps its own
background rather than relying on a page's.

**A sixth instance of the "shared ancestor" bug, and the only one so far that was really a
plain migration mistake rather than a genuine layering hazard.** `AgreementsPage`'s table
was ported straight from `<div className="table-scroll"><table>...` to shadcn's `<Table>`,
in `<main>`, with no `Card` -- unlike every sibling admin page, which wraps its `Table` in
one. That was safe in the old stylesheet, where `<table>` inherited colors that already
matched the dark backdrop it always floats on; it is not safe with shadcn's `Table`, whose
`TableHead` defaults to `text-foreground` and whose own added `text-muted-foreground` cell
text are both *replacement* colors, exactly the thing the rule says never to claim without
also claiming the background under them. Axe caught it immediately (4 headers + 4 subtext
cells at failing contrast); fixed by wrapping the listing in its own `Card`, matching the
`AdminUnitsPage` reference pattern (filter bar in one `Card`, table in a second) rather than
patching individual text colors -- the right fix here, unlike the `DashboardPage` cases,
because this text was never meant to float in the first place.

`AgreementsPage`'s scope-editing modal still renders `CheckboxCardGroup` unmigrated --
deliberately deferred to the batch of form-page components in the next phase -- inside the
now-Radix `Modal`, whose own `.theme-light` wrapper (see its docstring, Phase 1) is exactly
what makes that safe: the modal body renders old-stylesheet content correctly regardless of
the host page's own migration state.

## Migrating to shadcn/ui, continued: the three registration forms, and `RadioCardGroup`/`CheckboxCardGroup`

`EquipmentFormPage`, `UnitFormPage`, and `ClinicFormPage` -- the three "three modes, one
component" dedicated-route registration forms -- are now on shadcn's `Card`/`Input`/`Label`/
`Select`/`Switch`/`Alert`, each numbered section its own `Card` for the same "shared
ancestor" reasoning as every other migrated page: a `Card` is a claimed light background, so
everything inside it may use Tailwind's semantic text colors directly.

`RadioCardGroup` and `CheckboxCardGroup` -- the modality pickers shared across
`EquipmentFormPage`/`UnitFormPage`/`AgreementsPage`'s scope modal -- moved onto Radix
`RadioGroup`/`Checkbox` rather than styled native inputs with a click handler. The visible
selected-card highlight is still CSS-only, now via Tailwind's `has-[[data-state=checked]]:`
variant on the `<Label>` wrapping each item -- the direct equivalent of the old
`.radio-card:has(input:checked)`, just keyed on Radix's own `data-state` attribute instead of
`:checked`.

Every native `<select>` in these three forms became a Radix `Select`, needing a sentinel for
whichever states an empty-string `value` used to carry (`Select.Item` rejects `""`): `UNIT_AUTO`
for "assign automatically" (equipment's own unit picker, a real value, not a placeholder) and
`MANAGER_UNASSIGNED` for "no manager assigned" (unit/clinic forms, real in edit/view, never
offered in create). Everywhere the old empty option was actually just "nothing chosen yet"
(establishment type, state, the clinic-create manager placeholder) needed no sentinel at
all -- that's exactly what `SelectValue`'s own `placeholder` prop is for, and a disabled
placeholder `<option>` was never a Radix concept to begin with.

**A sixth instance of the "shared ancestor" rule, and the first one caused by a shadcn
component's own variant, not by anything of this codebase's own making.** `EquipmentFormPage`'s
bottom-of-form "Cancelar" button used `variant="outline"`, the same variant `AgreementsPage`'s
modal footer uses safely -- but *that* one sits inside a `Dialog`, which claims foreground
properly, and this one sits directly in `<main>`, unclaimed. "outline" sets no text color at
rest at all (only `hover:text-accent-foreground`), so at rest it silently inherited `body`'s
old dark `#e6e8eb` against the new light `bg-background` -- 1.09:1, caught immediately by axe.
Same root cause as every other instance of this bug, but the first time the unsafe color came
from a component's own default rather than an explicit Tailwind class written here. Fixed by
switching to `variant="secondary"` (explicit `bg-secondary text-secondary-foreground` at rest,
no reliance on an ambient color) -- which is also what every other migrated page already uses
for this exact "Cancelar"/"Voltar" button, so this was a plain inconsistency, not a new
convention. The take-away for the remaining pages: **`variant="outline"` is only safe inside
something that has already claimed a foreground color (`Card`, `Dialog`) -- never on a button
floating directly in `<main>`.**

**Test infrastructure adjustment, made incrementally rather than deferred to one big Phase 4
pass.** A native `<select>` becoming a Radix `Select` breaks Playwright's own
`locator.selectOption()` (it only knows how to drive a real `<select>`), which the a11y test
suite depended on for every one of these forms' state/establishment-type/technical-manager
pickers. Rather than leave those five call sites broken until a later cleanup phase, a
`selectRadixOption(page, label, option)` helper was added to `tests/a11y/helpers.ts` now and
the affected calls (`UnitFormPage`'s and `ClinicFormPage`'s own tests) were fixed in the same
pass that broke them -- it opens the trigger by its accessible label, then clicks the matching
item in the popover listbox that opens, matching by visible text (a plain string) or by
position (`{ index }`, for "any eligible seed account will do" cases that don't care which one).
`WorkstationPage`/`ExamPage`'s own clinic/unit/room selects are untouched for now -- those pages
are still on native `<select>`s until their own migration phase, so their `.selectOption()`
calls still work exactly as before.

## Migrating to shadcn/ui, continued: the teleoperation suite -- a light shell around a black console

`WorkstationPage`, `SessionPage`, `ExamPage`, and `SessionReplayPage` -- the last cluster of
pages, and the highest-risk one, since `SessionPage`/`ExamPage` are the only screens whose
markup a *hook* (`useHidInput`) depends on structurally, not just visually. `WorkstationPage`
was low-risk (already `ConsoleShell`/pt-BR, same "numbered `Card` sections" shape as the
Phase 3d form pages); the other three needed a real design decision first: they'd always
used a dark "cockpit" aesthetic distinct from the rest of the app, on their own standalone
page shell (no `ConsoleShell`). Asked and confirmed: convert them to the app's one light
theme like everything else, but keep the console/video surfaces themselves -- `.console-box`,
`CctvPip`, `RoomCameraPanel` -- literally black regardless of theme, the same self-contained-color
treatment a `Badge` already gets, since they're real video surfaces, not page chrome. `SessionPage`
and `SessionReplayPage`'s own English text was left untouched -- they predate `ExamPage`'s
pt-BR pass and re-translating them is a separate concern from a styling migration. Every
shared component the cockpit renders moved too: `QueueStrip`, `PttButton`, `ExamChat`,
`ShortcutChips`, `RoomCameraPanel`, `CctvPip`.

**The one genuine structural constraint, respected rather than worked around.** `useHidInput`
reads `canvas.getBoundingClientRect()` on every `mousemove` and feeds it straight into
`toAbsoluteHidCoordinates`, on the documented assumption that the canvas's CSS box always
matches its intrinsic aspect ratio with zero letterboxing (`width: 100%, height: auto` --
see that hook's own docstring). The migrated console box keeps exactly that: `w-full block`
on the `<canvas>`, nothing else -- no `object-fit`, no fixed height, no aspect-ratio wrapper.
Verified after the fact, not just reasoned about: a real WHEP-less session's canvas box and
its container's `getBoundingClientRect()` came back pixel-identical, and a synthetic click on
the canvas still reached `useHidInput`'s own listeners.

**A real, if minor, pre-existing bug found and fixed while touching this exact code.** The
HUD readout (`stream: … / input RTT: …`) and `CctvPip`'s picture-in-picture both float
`position: absolute` in a screen corner, directly on top of the interactive canvas -- and
neither the old `.hud` nor `.cctv-pip` rule ever set `pointer-events: none`. A real click
landing in that corner was always silently swallowed by the decorative overlay instead of
reaching the console underneath, on the *pre-migration* app too -- confirmed by a synthetic
click there timing out on "element intercepts pointer events" during this pass's own
verification. Fixed by adding `pointer-events-none` to both overlays now that the exact
geometry was already being re-examined for the reasons above; unrelated to the theme change
itself.

**A second real bug, older and unrelated to this phase's own work, caught by the exact same
component-level fix that resolved the "shared ancestor" collision below.** `queue-display.ts`'s
`queueStatusBadgeClass`/`preparationStatusBadgeClass`/`queueCardChipOf`'s fasting-alert case
still returned the *pre-Tailwind* class strings (`"badge queue-waiting"`, etc.) -- dead
class names once `styles.css`'s own `.badge.queue-waiting` etc. rules stopped being the only
consumer. `NursingPage` (migrated earlier) already called `chip.badgeClass` expecting a real
Tailwind string, so its own queue-card status chips have been rendering with zero color ever
since that page's own migration, unnoticed because "no color set" doesn't fail axe's
contrast check the way a *wrong* color does. Fixed by porting every one of those functions'
return values to the same self-contained hex-pair convention `tailwindBadgeClassOf`
(equipment-display.ts) already established -- verified by screenshot on `NursingPage` itself,
not just the pages this phase actually touched.

**The seventh instance of the "shared ancestor" bug, and the first one this migration's own
docs didn't already have a name for.** `QueueStrip` (rebuilt on `text-muted-foreground` etc.,
correct for a light `Card`) is used *only* by `ExamPage`, which hadn't been converted yet at
the point `QueueStrip` was -- so for one intermediate commit, its cards rendered inside
`ExamPage`'s still-dark, unmigrated `.card`, and axe caught exactly the contrast failure
you'd expect (new light `text-muted-foreground` against the old dark `.card` background).
Not a lasting problem, unlike every other instance of this rule catalogued so far: `QueueStrip`
has one caller, and that caller was migrated in the same pass, so the failure was resolved by
finishing the phase, not by picking a different color. Documented anyway because the shape of
the bug -- a leaf component migrated correctly for the context it will have, briefly wrong for
the context it still has -- is exactly the risk every future phase in this series carries
whenever a shared component's callers don't all move in the same commit.

**Two stale test assertions, uncovered rather than caused by this phase, fixed in the same
pass since leaving them broken would mean shipping a phase with less real coverage than
before it.** `NursingPage`'s own a11y test located a patient's queue card via
`.queue-card-select` -- a class name that page's *own* migration (earlier than this phase)
already removed, silently zeroing that locator's match count and skipping the whole
"select a patient, enable editing" verification block ever since, with no failure to point at
it (the guard was `if (count > 0)`, exactly the shape that hides a locator regression instead
of surfacing it). Rescoped to the queue rail's own `<ul>` (`role="list"`, the first of two on
the page) instead of a class name now that cards are plain Tailwind buttons. That fix then
uncovered a *second*, older, independent staleness once the block actually started running
again: the very next line waited for `getByLabel("Tipo do Exame")`, a label that has only
ever existed in `NursingPage`'s *edit-mode* fields (`SummaryField`'s own read-only caption
has no `<label>` association at all) -- stale since whichever earlier pass merged the
read-only/edit views into one card. Fixed by waiting on the "Habilitar Edição" button itself,
which is what the test actually needed to confirm. `ExamPage`'s own equivalent locator (the
patient-info dialog's queue card, same dead class) got the identical `role="list"` fix.

**Test infrastructure, extended in the same incremental spirit as Phase 3d's.** `selectRadixOption`
now covers `WorkstationPage`'s own three pickers (clinic/unit/room) too -- the last of the
original eleven `.selectOption()` calls, all now migrated as each page's own `Select` landed,
with none deferred to a future cleanup pass. One button's own accessible name changed as a
side effect of using a real `Plus` icon instead of a literal "+" character (`ShortcutChips`'
"+ Criar Atalho" -> "Criar Atalho") -- the same convention `NursingPage`'s "Novo Exame" button
already established; the one test asserting the old literal string was updated to match.

**Every page in the app is now on shadcn/Tailwind**, except `LatencyClockPage` -- deliberately
untouched, per its own docstring: a standalone diagnostic clock meant to run on the *target*
machine being remotely controlled, not inside the authenticated app shell or its theme at
all, so there is nothing here for this migration to convert.

## Migrating to shadcn/ui, concluded: claiming `<main>`, and deleting `styles.css`

The last step, once every page was actually on shadcn/Tailwind (Phase 3e's own closing
line): finish what the "shared ancestor" rule had been deliberately deferring since Phase
3b. `ConsoleShell`'s `<main>` -- and `AuditPage`/`ClinicHomePage`'s own standalone one --
had never claimed `bg-background`/`text-foreground`, because doing so would have broken
whichever sibling page hadn't migrated yet (a real bug, hit and reverted early in this
series). With nothing left unmigrated, that constraint no longer applied, so `<main>` claims
both now, and every one of the ~38 `var(--color-muted)`/`var(--color-accent)` inline-style
workarounds this rule had produced across 10 files -- the breadcrumb/subheading/required-
legend text that used to float directly in an unclaimed `<main>` -- became a plain
`text-muted-foreground`/`text-primary` utility class instead, the same as everything else.
`Modal`'s own `.theme-light` wrapper (kept since Phase 1 specifically so an old-styled modal
body would still render correctly regardless of the host page's migration state) came out
too, now that every one of its 9 call sites renders real shadcn content. `visually-hidden`
was renamed to Tailwind's own built-in `sr-only` across 15 files rather than kept as a
bespoke utility duplicating it. `.page`'s three remaining usages (`ConsoleShell`,
`AuditPage`, `ClinicHomePage`) became direct Tailwind utilities (`mx-auto max-w-[960px] px-5
py-8`) instead of a named class with nothing left to share it. `styles.css` -- 1,504 lines,
zero remaining consumers, verified by grepping every one of its 118 top-level class
selectors against every `.tsx` file in the app before deleting -- and its `main.tsx` import
are gone; `index.css`'s own `@layer legacy;` pre-declaration (there only to keep
`styles.css`'s unlayered `a { color }` rule from outranking Tailwind utilities) went with it.

**One real, if narrow, regression this specific change caused, caught by axe rather than
missed.** `WorkstationPage`'s "Confirmar e Acessar Sala" button is disabled *by default* --
before any room is picked, not just transiently mid-submit like every other disabled button
in this app -- so it is the one a real page load, and axe's own first scan of that page,
actually sees in that state. Its default variant's `disabled:opacity-50` blends `bg-primary`/
`text-primary-foreground` at 50% opacity against whatever sits behind it; against the *old*
unclaimed, effectively-still-dark `<main>` that blend happened to still clear 4.5:1, and
against the *new* light `bg-background` it measured 2.24:1. Not a reason to leave `<main>`
unclaimed -- every other disabled button in the app is inside a `Card` (opaque, stable
backdrop) or disabled only during a brief async action rarely caught mid-scan -- so the fix
is local: this one button overrides the shared `disabled:opacity-50` with solid,
backdrop-independent `disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100`
instead, the same pairing the sidebar's own nav-count badge already relies on.

**The migration's own stated goal is done.** Every page in the app is on shadcn/ui and
Tailwind, one light theme throughout, with no page depending on an old, dark, unlayered
fallback anymore -- except `LatencyClockPage`, unchanged for the reason its own docstring
gives: it is not part of the authenticated app or its theme at all.

## What's intentionally not built

- **ATX (power) and MSD (virtual USB) control**: not implemented in `@crop/pikvm` at all, not
  hidden behind a permission check. See `docs/pikvm-integration.md` for the clinical-safety
  and PHI-exfiltration reasoning.
- **Operator-tunable mouse sensitivity/scroll-rate sliders, CapsLock LED sync, the
  modifier-hold "magic shortcut" composer**: all present in PiKVM's own web UI, all skipped
  here as polish that doesn't affect correctness or safety, in the interest of the 30-day
  timeline.
- **A contrast-dose calculation derived from patient weight**: `QueueEntry.patientWeightKg`,
  `contrastRequired`, and the nurse-entered `contrastVolumeMl` are recorded; no mL/kg dosing
  figure is ever computed or displayed — see both nursing sections above for why.
- **PDF/document upload for medical orders or triage questionnaires, on the nursing screen or
  anywhere else**: refused twice (the day-view task's own questionnaire PDFs, then again by the
  exam-data-overlay task's "Pedido Médico" block) while no file storage of any kind existed in
  this codebase. No longer true as a blanket statement: `ChatAttachmentStorageService` landed
  with the room-chat rework, and uploading the medical-order document itself (`QueueEntryDocument`
  -- "Pedido Médico"/"Laudo Anterior"/"Outro", via `POST /queue/:id/documents`) is now real too --
  see "Uploading the exam-order document itself" below. What's still refused, and for an entirely
  different reason now, is extracting structured data *from* an uploaded PDF (a physician's name/
  CRM) and verifying an ICP-Brasil signature -- nothing here parses PDF contents or performs real
  PKI chain verification, which has nothing to do with storage.
- **A consolidated cross-tenant audit view for an operating company**: session and equipment audit
  rows are written against the *clinic* whose data was touched, which is correct -- but it means an
  `OPERATOR_ADMIN` cannot yet read its own staff's activity across all of its client clinics from one
  place. Real, known, and unbuilt; see the contract section above.
- **Real two-way audio, and room sensor telemetry** (door/temperature/e-stop): the exam-support
  text chat is real and, since the room-chat rework below, usable by nursing as well as the
  operator. Push-to-talk *presence* (no audio, just "who is holding which channel") was built
  once, then removed outright in the same rework — a mock-fidelity feature nobody asked to keep
  once it was clear no audio transport was coming, not a hidden/disabled one; see
  `AuditAction.INTERCOM_PTT`'s own docstring for why the enum value survives (append-only audit
  log) even though every other trace of the feature is gone. Real voice still needs a WHIP/WHEP
  path `infra/mediamtx/mediamtx.yml` doesn't have and a room-speaker/gantry integration that
  doesn't exist; room sensor telemetry was never attempted in any pass, still nowhere in this
  codebase.
- **A room camera feed for equipment other than the one the seed script configures**: `RoomCameraPanel`/
  `CctvPip` render real video the instant `Equipment.cameraUrl` is set, for any room -- but no admin
  UI writes that field yet, and only `MRI-01` gets it from `SEED_MEDIAMTX_WHEP_URL`. A real,
  narrow gap: the panel's own empty state ("Sem câmera configurada") is what every other room shows.
- **Per-clinic timezones**: one configured `CLINIC_TIME_ZONE` for the deployment, not a
  `Tenant` column — see the day's-queue section above.
- **Exact agreement-scope narrowing for an `AUDITOR` homed in an `OPERATOR_PROVIDER` tenant**:
  `OperatorAccessService.isCrossTenantActor` uses role as a proxy for "home tenant is really
  OPERATOR_PROVIDER", exact for `OPERATOR`/`OPERATIONAL_SUPERVISOR`/`OPERATOR_ADMIN` but not for
  `AUDITOR`, which can legitimately be homed in either tenant type. Such an auditor, switched into
  a clinic their company's agreement covers, sees that clinic unscoped rather than narrowed to the
  agreement's own scope — wider than the operators they exist to audit, never wider than a clinic's
  own staff already see. See that method's own docstring for why a home-tenant-type lookup wasn't
  added to close it.

## The room-chat rework: equipment-scoped transport, attachments, intercom removal

Driven by a real gap the previous "exam cockpit" phase left unclosed: `ExamMessage` was
already stored per-equipment (not per-session), but *sending* one was still WebSocket-only and
gated on `JOIN_SESSION` — which nursing, never a session participant, could never call. Chat
existed in the schema and on `ExamPage`; it was structurally unreachable from `NursingPage`.

**Sending moved from the socket to REST.** `POST /chat/messages` (multipart, so it can carry
one optional attachment) is now the only write path; `SendExamMessageHandler` re-derives the
tenant + agreement-scope check itself (a REST call has no prior room-join to trust, unlike the
old design) and, on success, publishes `ExamMessageSentEvent` rather than broadcasting
directly. `SessionsModule`'s `BroadcastExamMessageHandler` reacts to that event and pushes
`RT_EVENTS.EXAM_MESSAGE_CREATED` — the identical anti-cycle shape `QueueUpdatedEvent` already
established, just running the opposite direction (there `QueueModule` publishes and
`SessionsModule` reacts to a queue write; here `ChatModule` publishes and `SessionsModule`
reacts to a chat write). `HID_INPUT`/`PRINT_TEXT` were not touched — those still have a real
reason to stay WebSocket-only (60Hz coordinates, a physically-held key) that a chat message
carrying a file never had.

**The socket's remaining job is `JOIN_EQUIPMENT_CHAT`**, a room join separate from
`JOIN_SESSION` (`equipment:<id>`, not `session:<id>`) that any authorized socket — nursing's
included — can call without ever starting or joining a session. Its access check
(`CanAccessEquipmentChatHandler`) is dispatched as a query from `SessionsGateway` into
`ChatModule`, the same "gateway dispatches a query/command into the module that owns the
domain rule" shape `onJoinSession`'s own `GetEquipmentQuery` already used — kept `SessionsModule`
from needing to import `AccessModule` just for this one check. `CHAT_ALLOWED_ROLES`
(`packages/shared/src/roles.ts`) is shared between this check and `ChatController`'s own
`@Roles`, specifically so a role excluded from the REST surface can never join the socket room
and sit there receiving live broadcasts of a conversation it could not otherwise list.

**Attachments are new**: `ExamMessage` gained four nullable columns (path/filename/mimeType/
sizeBytes — one optional attachment per message, not a child table, since this chat has no
reason to let one message carry several files). Storage is local disk
(`ChatAttachmentStorageService`, `CHAT_ATTACHMENT_STORAGE_DIR`), a deliberate mirror of
`SnapshotStorageService`'s own MVP scope decision, with the identical Railway-redeploy caveat
recorded in DEPLOY.md. The mime allow-list (`ALLOWED_ATTACHMENT_MIME_TYPES` — three image
types plus PDF) and the size ceiling are enforced server-side in `ChatController`, not just
client-side in `ExamChat` — the client check is a UX nicety, not the real gate. Download is a
separate authenticated route (`GET /chat/messages/:id/attachment`) that resolves the file
through the owning message row's own tenancy/scope check first, the same "never take a path
from the URL" discipline `SessionsController`'s snapshot-image route already established.

**Reads gained day-scoping.** `GET /chat/messages?date=YYYY-MM-DD` defaults to *today* — unlike
`GET /queue`'s own `date`, which stays genuinely unscoped for callers that need every entry
regardless of day (see `ListQueueByEquipmentQuery`'s own docstring) — because this route is new
enough, and single-purpose enough, that "today" is the only sensible default. `ExamChat`'s own
day picker (a plain `<input type="date">`, "Histórico:") drives this from both `ExamPage` and
`NursingPage`, which now share the one component.

**Default shortcuts got a live seeding path, not just a migration backfill.**
`CreateTenantHandler` now publishes `TenantCreatedEvent`; `ChatModule`'s
`SeedDefaultShortcutsHandler` reacts to it for `CLINIC` tenants, inserting
`DEFAULT_MESSAGE_SHORTCUTS` (`@crop/shared`) the same idempotent way the migration's own
one-time `ON CONFLICT DO NOTHING` backfill did. The two paths cover different clinics by
construction — the migration's backfill only ever reached tenants that existed *at migration-
apply time*; the event only ever reaches tenants created *after* it started listening — which
left a real gap for this repo's own seeded "Clinica Alpha"/"Clinica Beta": both predate *both*
mechanisms (created by `infra/seeds/seed.ts`, itself written before this feature existed).
Found by checking the live demo data, not by code review — the shortcuts row for Alpha's own
tenant simply didn't exist. Closed with a third, explicitly one-time tool,
`infra/scripts/backfill-default-shortcuts.ts` (`make backfill-shortcuts`), rather than folding
a third mechanism into the application code: a script that seeds every existing gap once is
the honest shape for a gap that, by definition, only pre-existing installations can have.

**Push-to-talk (`IntercomChannel`) was removed outright** — the gateway handlers
(`onIntercomPttSet`, `broadcastIntercomState`, `auditIntercomRelease`,
`releaseIntercomHoldsFor`), the in-memory presence registry, the contracts, and the enum. Not
hidden behind a flag: nobody asked to keep a presence-only, no-audio feature once a real
alternative (this chat, now reachable by both sides) existed. `AuditAction.INTERCOM_PTT`
survives as a retired enum member purely because `audit_logs` is append-only (a DB trigger
enforces it) and any row a completed hold produced before removal still references it —
nothing new can ever emit it again.

**A real, reproduced-live WebSocket bug, worth recording at length because the symptom looked
nothing like the cause and cost significant time to isolate.** After wiring `JOIN_EQUIPMENT_CHAT`
end to end, `NursingPage`'s socket would connect, then immediately disconnect with reason
`"transport close"`, reconnect a second or so later, and repeat — forever, from the very first
connection, whether or not anything else on the page was happening. A standalone Node
`socket.io-client` script exercising the *identical* server-side handler (same event, same
JWT, same equipment id) connected once and stayed connected. Systematic isolation — emptying
the gateway handler down to a bare `console.log`, swapping in unrelated pre-existing events
(`hid:print`, `session:join`) at the same call site, renaming the new event to an arbitrary
string while keeping everything else identical — narrowed it to one fact: only the specific
string `"chat:equipment:join"`, sent from the *browser*, ever triggered it; the same string
from Node, or a different string from the browser, never did. That pointed at the client
bundle, not the server. The actual cause: `apps/web`'s Vite dev server had pre-bundled
`@crop/shared` into `node_modules/.vite/deps/@crop_shared.js` *before* `JOIN_EQUIPMENT_CHAT` was
added to `ws-events.ts`, and — exactly as a much earlier entry in this document already
recorded for a different export — Vite's dependency-cache invalidation heuristics did not
detect the change across a long-running dev server that predated it. `RT_EVENTS.JOIN_EQUIPMENT_CHAT`
therefore evaluated to `undefined` in the browser; `socket.emit(undefined, {...})` is what
Chromium's WebSocket implementation apparently cannot round-trip cleanly against this server's
Socket.io version, corrupting the transport. Fixed by `rm -rf apps/web/node_modules/.vite` and
a fresh dev server start — no application code changed. Two long-running `nest start --watch`
zombie processes (one many hours old) simultaneously racing for port 3000 were found and
killed along the way; they were red herrings for *this* bug (both ran current code by the time
it was isolated) but had been silently determining which of two builds actually answered any
given request for an unknown stretch of this session, and are exactly the kind of
environment-state confusion worth killing on sight rather than reasoning around.

## Icon-only action buttons, and three real bugs found while polishing the UI around them

The admin-table cluster's row actions (view/edit/reactivate/deactivate on
`AdminEquipmentPage`/`AdminUnitsPage`/`AdminClinicsPage`, lock/unlock/reset-password/resend-
invite on `AdminUsersPage`, attach/send on `ExamChat`'s composer) moved from text buttons to
`lucide-react` icons (`Eye`, `Pencil`, `Ban`, `RotateCcw`, `Wrench`/`CircleCheck`, `Lock`/
`Unlock`, `KeyRound`, `Mail`, `Paperclip`, `Send`) at `size="icon-sm"`, each wrapped in
`Tooltip`/`TooltipTrigger`/`TooltipContent` (`TooltipProvider` was already mounted app-wide in
`App.tsx`) so the action is still nameable without a permanent text label crowding the row.
Icons default to `aria-hidden`; the wrapping `Button`'s own `aria-label` carries the
accessible name, the same split every other icon-only control in this app already uses.

Fixing that surfaced three real bugs, not just a redesign:

**`AgreementsPage`'s propose flow 403'd for the one role it exists for.** The operator-side
"Propor Contrato" picker called `GET /tenants` to list clinic options — a route that answers
`PLATFORM_ADMIN` only (see `TenantsController`'s own docstring: no caller's-own-tenant concept
to scope against). An `OPERATOR_ADMIN` clicking the button got a 403 back from that call
before ever reaching `POST /agreements`, on every attempt, unconditionally. The frontend had
also, independently, still been offering the same button to `PLATFORM_ADMIN`, whose own
`POST /agreements` attempt was *itself* a guaranteed rejection for an unrelated reason
(`ProposeAgreementHandler` derives the proposer's side from `actor.homeTenantId`, which for a
platform admin points at the `PLATFORM` tenant — neither `CLINIC` nor `OPERATOR_PROVIDER`).
Fixed by removing the platform-admin propose path outright (it could never have succeeded)
and adding `GET /agreements/clinic-options` (`ListClinicOptionsQuery`/`Handler`,
`ClinicAgreementOptionSchema` in `@crop/shared`), an `OPERATOR_ADMIN`-scoped route that returns
exactly the clinics the caller's own company could still propose to — not deactivated, and
excluding any clinic already `PENDING`/`ACTIVE` with them, so the picker never offers a choice
`ProposeAgreementHandler` would just reject with a `ConflictError` anyway.

**The 403 itself then leaked onto the page it came from.** `RolesGuard`'s raw
`"Requires one of roles: ..."` message landed in `actionError` — a single piece of state this
page's propose modal, its scope-editing modal, *and* the plain accept/reject/revoke row
actions all shared. Both modals render as an overlay; setting `actionError` while one is open
therefore populated a top-level banner the overlay was currently hiding, which only became
visible once the modal *closed* — reading, to whoever was looking, like a page-level error with
no visible cause. Fixed by giving each modal its own `close*()` helper (`closePropose`,
`closeScope`) that clears `actionError` on the way out, moving each modal's own error `Alert`
inside it so it is visible exactly when it is relevant, and gating the top-level banner to
`!proposeOpen && !scopeFor` so it is now only ever the row-actions' own error surface.

**A multi-clinic Manager's equipment count in `ConsoleShell`'s header did not update after
switching clinics** — it kept showing the *previous* clinic's numbers until a full reload.
`useEffect(() => {...}, [])`, with an `eslint-disable-next-line react-hooks/exhaustive-deps`
suppressing the warning that would have caught this: the fetch (`/equipment`, `/units`, and
`/tenants` for a platform admin) reads the caller's *active* tenant server-side, but never
re-ran when `useAuth().switchActiveClinic()` changed it. Fixed by keying the effect on
`[user?.tenantId, nav.canManagePlatform]` and clearing the three counts to `null` up front on
every re-run (so a stale "12/14 online" from the *old* clinic cannot sit there reading as
current while the new fetch is in flight) — verified live with a fresh Playwright check: the
seeded `gestor.multi@crop.health` account's pill genuinely changed from Alpha's own count to
Beta's own count on switch, no reload.

An audit for the same "mount-once, no clinic dependency" shape elsewhere turned up six more
instances (`AdminEquipmentPage`, `AdminUsersPage`, `AuditPage`, `NursingPage`'s equipment/unit
list, `ExamPage`'s active-session lookup) — none currently reachable, because this app fully
unmounts every page on navigation and `switchActiveClinic` is only ever called from
`DashboardPage`/`WorkstationPage`'s own pickers, so every other page only ever mounts *after*
a switch has already resolved. Fixed anyway, keyed on `user?.tenantId`: cheap insurance against
a future persistent nav/switcher silently reintroducing the exact bug just fixed above.

## Finishing `DashboardPage`'s translation, and the inconsistency that translating it exposed

`DashboardPage` was the one page in the shadcn migration's translation pass left mid-way — the
`dashboard` namespace (heading, queue-table copy, error strings) existed in `pt-BR.ts` from an
earlier pass, added but never wired in, so the page itself still read English. Finished here:
every hardcoded string now goes through `t("dashboard:*")`, and the equipment-status badge and
per-entry queue-status badge now reuse `equipment-display.ts`'s `statusLabelKeyOf`/
`adminEquipment:status*` and `queue-display.ts`'s `queueStatusLabelKeyOf`/`nursing:queueStatus*`
respectively — the same enum-to-label mapping `AdminEquipmentPage`/`NursingPage` already
established, rather than a third copy of either vocabulary. `queue-display.ts`'s own docstring
used to call this page out by name as the deliberately-unmigrated exception to that reuse; it
no longer is.

Translating the "Log de Auditoria" link this page navigates from broke the page it navigates
*to*: `AuditPage` was still entirely English, so clicking through now landed on a page that
switched languages mid-flow. Not a reason to revert the link's own translation — `AuditPage`
was translated too (a new `audit` namespace), with one deliberate exception: the log table's
own `action`/`resourceType` columns stay as their raw `AuditAction`/resource-type identifiers.
That log's entire value proposition is the exact, hash-chained identifier a tamper check
verifies against (see `AuditAction`'s own docstring) — translating those would trade a precise
technical label for an approximate one in the one screen where precision is the point, the
same reason a stack trace does not get localized either.

The a11y suite's own "ForcePasswordChangePage" test was found broken by this work's own full-
suite verification pass, on a freshly reset database — unrelated to anything above (confirmed
via `git log`/`git diff` against the unmodified files), but real: it `POST`ed
`{ password: tempPassword }` straight to `/users` to set up its fixture, a request shape
`CreateUserRequestSchema` had already stopped accepting entirely once every HTTP-created
account moved to the invitation flow (`SendInvitationHandler` — no admin-typed password has
existed on that path for some time), and it never sent `clinicTenantIds`, which `NURSING` has
required since the Manager/Supervisor/Nursing membership model landed. The underlying
mechanism the test is about (`mustChangePassword` routing straight to the forced-change screen)
is not dead, though — it just has exactly one live producer left, `POST /users/:id/reset-
password` (`AdminResetPasswordHandler`, `AdminUsersPage`'s own "Redefinir senha" button), an
admin resetting an *existing* account's password rather than setting one at creation. Rewritten
to match: invite the account for real, activate it (the account's own password, no forced
change), complete first-login MFA enrollment, and only then have the admin reset it — the one
remaining path that actually produces the screen under test.

## Uploading the exam-order document itself

Closes a gap this document has refused outright, by name, four separate times across four
different features (the day-view task's questionnaire PDFs, the exam-data overlay's "Pedido
Médico" block, the "What's intentionally not built" summary, and `NursingPage`'s own
docstring) — every one of them for the same reason: no file storage existed anywhere in this
codebase at the time. That stopped being true the moment the room-chat rework shipped
`ChatAttachmentStorageService`. This feature is what actually closes the gap those four
entries were about, rather than just making the excuse stale — each has been corrected in
place above rather than left standing.

**`QueueEntryDocument`, a child table, not a fifth nullable column group on `QueueEntry`.**
Every prior attachment-shaped feature in this schema (`ExamMessage.attachmentPath`/
`attachmentFilename`/`attachmentMimeType`/`attachmentSizeBytes`) chose a nullable column
group because one chat message never needs more than one file. An exam order doesn't share
that constraint: "pedido médico" and "laudo anterior" (a prior report the patient brought in)
are genuinely different documents a nurse would plausibly attach to the *same* exam, and a
column group can only ever say "zero or one," never "a growing list." `kind` is a
`QueueDocumentKind` enum (`PEDIDO_MEDICO`/`LAUDO_ANTERIOR`/`OUTRO`) the nurse picks at upload
time, defaulting to `PEDIDO_MEDICO` — real information for the list to carry, not dead schema,
since the two kinds actually matter to whoever reads the list later.

**Storage is `QueueDocumentStorageService`, a close mirror of `ChatAttachmentStorageService`**
(local disk, keyed by the owning resource's id, a random on-disk filename so neither a
path-traversal attempt nor a same-name collision can reach `writeFile` through an uploaded
filename) — but on a volume this time. Chat attachments and session snapshots shipped onto
genuinely ephemeral container disk, wiped on every Railway redeploy, a tradeoff DEPLOY.md
documented rather than solved. A physician's order is a different class of record than a
chat photo, and attaching a volume for this feature was the point at which fixing the other
two for free stopped being extra scope and started being "the volume is already here" — see
DEPLOY.md's own "Known limitations" for where that tradeoff used to be recorded and no longer
needs to be.

**The authorization split is the most important design decision here, and it's an asymmetry
on purpose.** Upload and removal (`POST /queue/:id/documents`, `POST .../documents/:docId/
remove`) are nurse-side only (`NURSING`/`LOCAL_SUPERVISOR`/`CLINIC_ADMIN`/`PLATFORM_ADMIN`,
the identical role set `UpdateQueueEntryDetailsHandler` already uses) and gated by
`QueueEntry.assertDetailsEditable()` — the same WAITING/IN_PROGRESS-only rule the rest of the
exam-detail form already enforces, since adding to a DONE/CANCELLED record would be
rewriting history rather than recording it. Reading the content
(`GET .../documents/:docId/content`) is different in both directions at once: it is open to
the *entire* class-level role set, including a contracted operator who has no write access to
this list at all, and it has **no status gate whatsoever**. A completed exam's order is still
a record worth retrieving — the remote operator who needs to see what was ordered has no
reason to lose read access to it the instant the nurse marks the exam DONE. The content route
is also the one place this feature checks `OperatorAccessService.assertCanReachEquipmentId`
(the cross-tenant agreement-scope check `GetQueueEntryHandler` already makes for the same
reason) — upload/remove never do, because a nurse's own write is always same-tenant,
same-clinic, and agreement scope has no bearing on it.

**Removal is a real hard delete — row and bytes both — not a `deletedAt` column.** A
mis-uploaded document is PHI; "removed" has to mean gone, not hidden-but-still-on-disk and
still joinable by id. The row is deleted *before* the bytes, not after:
`QueueDocumentRepositoryPort.delete`'s own docstring explains why that ordering, and not the
reverse, is the one that can't leave a document reachable after the call returns
successfully — if the byte-deletion step then failed, the result is an orphaned file nothing
can ever reach again (the content route resolves through a row that's already gone), not a
dangling row pointing at bytes that no longer exist. The former is a disk-space leak; the
latter is a 500 on every future read attempt. What persists either way is the append-only,
DB-trigger-enforced `audit_logs` row (`QUEUE_DOCUMENT_REMOVED`) recording that the document
existed and who removed it.

**Audit `details` carries `kind`/`mimeType` only, never `filename`** — the same rule
`SendExamMessageHandler` already follows for chat attachments, for the same reason: a
clinician-chosen filename can itself carry a patient's name ("Jose-da-Silva-exame.pdf"), and
the audit table must not become a second, less-protected copy of PHI the rest of this
codebase goes out of its way to minimize.

**One shared mime allow-list, not three independent copies that happened to agree.**
`ALLOWED_ATTACHMENT_MIME_TYPES` used to be hand-duplicated between `ChatController` and
`ExamChat.tsx`, each commenting that the other had to be kept in sync by hand — tenable at
two copies, not at three. `@crop/shared` now exports one `ALLOWED_DOCUMENT_MIME_TYPES`
(images + PDF, deliberately excluding DICOM: browsers report no reliable mime type for
`.dcm`, and nothing in this app can render DICOM once stored anyway), and `ChatController`,
`ExamChat.tsx`, and `QueueController`/`NursingPage`/`ExamPage` all import the same constant.
If chat and documents ever need genuinely different allow-lists, split it back into two named
exports then — nothing requires them to stay equal forever, only that nothing today has a
reason to diverge.

**Two more safety-questionnaire facts, `metforminUse`/`anticoagulantUse`, landed in the same
pass** — tri-state (`boolean | null`) like `allergyStatus`, not two-state like
`fastingConfirmed`/`contrastRequired`: "not asked yet" and "asked, answered no" are different
states a plain defaulted boolean can't tell apart, the identical reasoning that already
justified `allergyStatus` being a closed enum instead of a boolean. Rendered as a `Select`
with the same `UNSET` sentinel `patientSex`/`allergyStatus` already use, not a `Checkbox`.

**A real `nested-interactive` axe violation, caught by the a11y suite's own new coverage, not
by review.** `FileDropzone`'s first draft wrapped the whole drop target in `role="button"`
with its own `tabIndex`/`onKeyDown`, containing a hidden `<input type="file">` given
`tabIndex={-1}` on the theory that a negative tabindex would keep assistive tech from ever
reaching it. Axe correctly flagged this anyway: a negative `tabIndex` only removes an element
from *Tab order* — it does not stop a screen reader's own non-linear navigation (rotor,
form-control list) from reaching a genuinely interactive element nested inside another one
that itself claims an interactive role, which is exactly what WCAG's "nested interactive
controls" rule exists to catch. Fixed by removing the role/tabIndex/keydown handling from the
outer box entirely — it is now a plain `<div>` whose only job is drag-and-drop visual
feedback (mouse/pointer-only by nature; there is no keyboard equivalent of "drag a file" to
begin with) — and relying on exactly one real, properly-exposed control: the "Procurar no
Terminal Local" `<Button>`, the same "visible button `.click()`s a hidden sibling input via a
ref" shape `ExamChat`'s own Paperclip control already used correctly from the start. The
outer box keeps a convenience `onClick` for a sighted mouse user (click anywhere in the box,
not just the button) — harmless now that it is no longer the thing *standing in* for an
accessible entry point, since the Button alone already covers every keyboard/screen-reader
path to the same picker.

**One Railway volume (`api-storage`, mounted at `/app/apps/api/storage`) fixes three
features' redeploy-durability at once, with zero environment-variable changes.** The API's
runtime `WORKDIR` (`apps/api/Dockerfile`) is `/app/apps/api`, and `SNAPSHOT_STORAGE_DIR`/
`CHAT_ATTACHMENT_STORAGE_DIR`/`QUEUE_DOCUMENT_STORAGE_DIR`/`MAIL_OUTBOX_PATH` all default to
`./storage/*`, resolved relative to that same `WORKDIR` — so one volume mounted at
`/app/apps/api/storage` puts every one of them on persistent disk without touching a single
default. Before this volume existed, session snapshots and chat attachments were wiped on
every redeploy/restart, a tradeoff DEPLOY.md documented as deliberate for a demo; a
physician's order is not something a demo tradeoff should apply to, which is what made adding
the volume now, rather than deferring it again, the right call.

