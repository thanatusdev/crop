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

## What's intentionally not built

- **ATX (power) and MSD (virtual USB) control**: not implemented in `@crop/pikvm` at all, not
  hidden behind a permission check. See `docs/pikvm-integration.md` for the clinical-safety
  and PHI-exfiltration reasoning.
- **Operator-tunable mouse sensitivity/scroll-rate sliders, CapsLock LED sync, the
  modifier-hold "magic shortcut" composer**: all present in PiKVM's own web UI, all skipped
  here as polish that doesn't affect correctness or safety, in the interest of the 30-day
  timeline.
