# RadLink — Clinical Remote Operation Platform (MVP)

Multi-tenant platform for remote operation of clinical equipment (MRI/CT) via PiKVM, with
mandatory 2FA, enforced supervisor takeover, and a hash-chained append-only audit trail.

See [`docs/architecture.md`](docs/architecture.md) for the system design and the reasoning
behind its MVP-scope tradeoffs, and [`docs/pikvm-integration.md`](docs/pikvm-integration.md)
for the PiKVM wire protocol and every edge case (keyboard layouts, coordinate math, the
stuck-key safety mechanism) this integration depends on.

## Features

### Authentication & security
- **Mandatory 2FA (TOTP)** for every account, no exceptions and no self-service registration
  — a new account is admin-created and invited (see "Invitation-based onboarding" below),
  and the *new user's own* first login walks them through enrollment (scan the QR/enter the
  code) via the same flow every seeded account goes through.
- **Self-service password reset via email** — "Esqueci a senha" on the login screen sends a
  single-use, 15-minute link (`POST /auth/password-reset/request` /
  `.../password-reset/confirm`). The response is identical whether or not the email belongs
  to a real account, so the endpoint can't be used to enumerate valid users. A successful
  reset revokes every existing session, but 2FA still gates the next login — the link alone
  can't take over an account. No real email provider is required to run this: it defaults
  to writing messages to a local file (`MAILER_DRIVER=file`); set `MAILER_DRIVER=resend` +
  `RESEND_API_KEY` to actually send mail.
- **Enforced password policy, history, and expiry-based forced rotation** — every password
  set anywhere in the app (registration, self-service reset, admin reset, in-band forced
  change) must be 8+ characters with upper/lower/digit/symbol, must not contain the
  account's name or email, and must not match any of the last 5 passwords used
  (`PASSWORD_HISTORY_DEPTH`). Passwords expire after 90 days by default
  (`PASSWORD_MAX_AGE_DAYS`, 0 disables expiry) or immediately after an admin-triggered reset;
  either way, the *next successful login* (after 2FA, so a stolen-password-no-MFA-device
  attacker learns nothing) walks the user through changing it in-band, with a live strength
  meter and policy checklist, before minting a real session — no separate re-login required.
- **Admin-forced password reset** now also revokes every existing session and forces that
  in-band change on the account's next login, taking effect immediately, not just on future
  logins.
- **Redis-backed rate limiting** on login, MFA verification, and password-reset request/
  confirm, each keyed by target account.
- **Account lockout** (admin-triggered), taking effect on the account's very next
  refresh/login.
- **Refresh-token rotation and revocation** — a real logout invalidates the token
  server-side; a leaked-and-reused old refresh token fails outright instead of silently
  working forever.
- **Multi-tenant isolation enforced at every query/command**, not by a single blanket guard
  — a resource that belongs to another tenant is a 403, never a 404 or a silent leak.
- **Standard security headers (`helmet`) and strict, credentialed CORS**; no cookie-based
  auth anywhere (every request carries a bearer token the browser attaches itself), so
  session fixation and CSRF don't apply to this API's auth model at all, not just
  "mitigated." Dependencies audited (`pnpm audit --prod`): no findings on the running API's
  actual request path.

### Biomedic workstation selection (`/posto-de-trabalho`)
The `OPERATOR` ("Operador Biomédico") role's new post-login home: pick the unit and room for
the shift before reaching any equipment.
- **Unit and room dropdowns**, the room list scoped to whichever unit is selected (a "room"
  is a piece of equipment's `roomLabel` — there is no separate `Room` model). Selection lives
  in the URL, so it survives a reload.
- **A read-only access-profile panel** (identity + role capabilities) — role comes from the
  session's own JWT, never a choice made on this screen.
- **The selected room's real status** (the equipment health-poller's own badge) and **today's
  real patient-queue count** for it.
- **Confirm** scopes the dashboard to that one room (`?equipmentId=`), with a "Trocar posto de
  trabalho" link back to this screen from there.

### Remote control sessions
- **Start/end a session** against any of your tenant's `ONLINE` equipment (one active
  session per piece of equipment, enforced; up to `MAX_CONCURRENT_SESSIONS_PER_OPERATOR`
  concurrent sessions per operator).
- **Real-time HID input forwarding** (keyboard + mouse) over a dedicated WebSocket channel,
  gated live on who currently holds control. Input forwarding itself is a near-instant,
  fire-and-forget control-plane send (see the HUD's *measured* round-trip time below); the
  ~200ms budget and PiKVM capture/encode/relay/decode breakdown in `docs/architecture.md`
  describe the separate *video* glass-to-glass path, not HID input.
- **Type text**, not per-keystroke — accented/non-Latin characters render correctly via
  PiKVM's own per-equipment keymap, and the action is confirmed on-screen the moment it's
  sent.
- **Emergency release** ("unstick keys") on demand, and automatically on disconnect,
  takeover, and idle timeout.
- **Supervisor/admin takeover** of an in-progress session, and **returning control back to
  the operator** without ending the session — both update every connected participant's UI
  live, not just the two people involved.
- **Idle-session auto-abort**: a session nobody's touched for `SESSION_IDLE_TIMEOUT_MS`
  frees its equipment automatically, audited with `reason: idle_timeout`.
- **Live input-latency HUD** (measured round-trip time, not an estimate, on every session —
  a Socket.io control-plane echo (`latency:ping`/`latency:pong`), which never touches PiKVM or
  video, so it is not the same number as the video glass-to-glass budget below).
- **Session snapshots**, captured periodically for the session's duration, and a **replay
  viewer** afterward that scrubs through them with the surrounding audit events (input
  batches, print actions) shown alongside each frame.
- **Optional room-camera picture-in-picture** via a separate WebRTC/WHEP path (MediaMTX) —
  intentionally never the same pipe as the console video, and allowed the latency the
  console path isn't.
- **A standalone, unauthenticated "proof clock" page** (`/latency-clock`) — opened on the
  target machine itself, not the operator's, so a single photograph of both screens side by
  side is a real, human-verifiable *video* glass-to-glass latency measurement — the only way
  to actually check the estimated budget above against reality, since neither this codebase
  nor the input-latency HUD measures video latency itself.
- **One unreachable device can never take down another tenant's session** — every
  hardware-facing connection is timeout-bounded and safe-by-construction against an
  unhandled connection error; an offline/misconfigured PiKVM degrades to `DEGRADED`/
  `OFFLINE` for its own equipment, not a process crash affecting everyone else.

### Patient queue
- **Add a patient** to a piece of equipment's queue; **cancel** a still-`WAITING` entry.
- **Automatic status transitions** (`WAITING` → `IN_PROGRESS` → `DONE`) as a session against
  that entry starts and ends — no manual bookkeeping.
- **Live push**: another user's queue change appears on your dashboard immediately, no
  reload needed.

### Nursing (`/enfermagem`)
The `NURSING` role's main screen (also reachable by `LOCAL_SUPERVISOR`/`CLINIC_ADMIN`/
`PLATFORM_ADMIN`): **the day's patient queue for one room**, with the selected patient's exam
record below it. Everything is per-room, via a room picker in the header.
- **The day's queue** — "Fila da Sala · N Pacientes Hoje", a horizontal strip of patient
  cards in the room's own priority order. Scoped to *today* in the clinic's configured
  timezone (`CLINIC_TIME_ZONE`, default `America/Sao_Paulo`), not to every entry the room has
  ever had. An entry with no explicit scheduled time falls back to its creation day rather
  than disappearing from every view.
- **Room context** — "Sala RM-01 · RM · Unidade Jardins · Siemens Magnetom Vida 3.0T", plus
  the signed-in nurse's own name and professional registration ("Fernanda Alves ·
  COREN-SP 148209"). All real data from `Equipment`/`Unit`/`User`.
- **Per-card status chips** — "Em espera" / "Em exame" / "Concluído", and **"Alerta Jejum"**
  for a contrast patient whose fasting hasn't been confirmed yet (a workflow reminder derived
  from the questionnaire below; it never gates any action).
- **Patient preparation quick actions** — "Paciente Posicionado" / "Injetado" / "Paciente
  Liberado", one click each, driving `PreparationStatus` on the queue entry. `INJECTED` is
  skippable (a plain exam with no contrast goes straight from positioned to released).
  Release is blocked while a session against that patient is still `ACTIVE` — enforced
  server-side, not just a disabled button — and the whole room's operational lock banner
  reflects that same real, database-enforced rule.
- **Queue reordering** — drag a patient card (or use the "Antecipar"/"Postergar" buttons, the
  accessible, keyboard-operable path) to change the room's priority order, then "Confirmar
  Nova Sequência" to commit. Only `WAITING` patients participate; a patient already in the
  room or already finished keeps their place and can't be dragged. A live "queue changed
  elsewhere" notice appears, without discarding your own unconfirmed draft, if another
  device reorders or edits the same room first.
- **Exam details per patient, read-only by default** — a "Habilitar Edição" toggle unlocks
  the fields; the preparation quick-actions above stay live regardless (a clinical act, not a
  record edit). Covers exam description, whether contrast is required and its recorded
  volume, sex, body weight, the scheduled time, and free-text clinical notes, with a "Salvar
  Alterações deste Paciente" button. Editable while the patient is `WAITING` or
  `IN_PROGRESS`; locked once their visit is `DONE`/`CANCELLED`.
- **Safety questionnaire** ("Questionário de Segurança & Contraste") — fasting confirmed +
  hours, creatinine (mg/dL), allergy status + description, and continuous metformin/
  anticoagulant use. Recorded and displayed as entered; nothing here is interpreted into a
  clinical decision by the platform.
- **Exam-order documents** ("Documentação do Exame") — upload the physician's order, a prior
  report, or another related document (PDF/PNG/JPEG/WEBP, drag-and-drop or "Procurar no
  Terminal Local"), tagged as Pedido Médico/Laudo Anterior/Outro. Immediate, not part of the
  "Salvar Alterações" draft; available while the patient is `WAITING`/`IN_PROGRESS`, same as
  the rest of this card. The remote operator sees the same list read-only in the exam
  cockpit, with no upload/remove affordance and no status gate — a completed exam's order is
  still worth retrieving.
- **Write attribution** — "Registrado às 08:14 por Fernanda Alves" on every saved record.
- **"Novo Exame"** — add a patient to today's queue (name + scheduled time).
- **Per-exam timeline** — the selected patient's own activity (added to the queue, details
  updated, positioned/injected/released), with times and who did each. Backed by the real
  audit trail, through a resource-scoped route: `NURSING` reads this one exam's rows without
  gaining access to `GET /audit` itself.
- **Live push**: another device's reorder, detail edit, or preparation-status change shows
  up immediately, the same `QUEUE_UPDATED`/`PATIENT_PREPARATION_UPDATED` events the
  dashboard's own patient queue already uses.

### Equipment management (Clinic Admin / Local IT / Operator Admin / Platform Admin)
- **Equipment registry** — register a scanner with its clinical identity: the exam modality it
  performs (MRI / CT / Ultrasound), brand, model, serial number, the room it physically stands
  in, and its installation/homologation date, alongside the PiKVM host/credentials, target OS,
  keymap (validated against PiKVM's real supported layouts), screen size, and optional
  room-camera URL. Every clinical field is required at registration — the columns are nullable
  only for rows that predate the feature, and nothing new joins that set.
- **Listing screen** with per-status and per-modality summary counts, free-text search across
  name/brand/model/serial, status + modality + unit filters (kept in the URL, so a filtered
  view is linkable), client-side pagination, and a CSV export of the filtered rows.
- **Dedicated create / edit / read-only view pages** (`/admin/equipment/new`,
  `/admin/equipment/:id`, `/admin/equipment/:id/edit`).
- **Edit equipment settings** after creation, including rotating its PiKVM credentials
  (leave the password blank to keep the existing one unchanged). Clinical fields can be
  corrected but not blanked out.
- **Optional DICOM node details** (AE Title, host, port) recorded per device. These are
  **stored metadata only** — this platform has no DICOM/PACS integration, opens no DICOM
  association, and sends or receives no images; the form says so where the fields are. AE
  Titles are still validated against DICOM's real 16-character constraint, because storing a
  value the external PACS would reject is worse than storing nothing.
- **Retire / return equipment to service** (`deactivatedAt`) — the "delete" action, since
  there is deliberately no hard delete: `Session`/`QueueEntry` rows carry real foreign keys to
  equipment and feed the append-only audit trail, so a `DELETE` would either be rejected by
  those constraints or destroy the history the trail exists to keep. Retiring blocks new
  sessions and removes the device from health polling; a session already in progress is
  deliberately **not** aborted (see `docs/architecture.md`).
- **Automatic health polling** every 10 seconds reflects real device reachability as
  `ONLINE`/`OFFLINE`/`DEGRADED` — this is never a value nobody updates after creation.
- **Manual maintenance mode**: pull a device out of rotation (blocks new sessions the same
  way `OFFLINE` does) without the health poller silently reverting it back within the next
  poll cycle.
- **Live status push**: an equipment's status changing — automatically or manually — reaches
  every connected dashboard immediately.

### Unit management (Clinic Admin / Local IT / Operator Admin / Platform Admin)
- **Unit registry** — a clinic's own sub-sites (each with equipment and rooms), registered
  with an institutional identity: establishment type, declared exam modalities (MRI / CT /
  Ultrasound / X-Ray), a technical manager (a real, already-registered user of the same
  clinic holding an eligible role), and a full physical address (CEP, street, number,
  district, city, state) plus optional CNES code, phone, and technical e-mail. Every field is
  required at registration except the contact trio — the columns are nullable only for rows
  that predate the feature (including the migration's own backfilled "Unidade Principal" per
  clinic), and nothing new joins that set.
- **A unit is always linked to a real, active clinic** — `ClinicAccessChecker` verifies the
  target tenant exists, is type `CLINIC`, and is not deactivated, for every actor including
  `PLATFORM_ADMIN`.
- **Listing screen** with summary counts (total, active, rooms, linked equipment), free-text
  search, status/clinic/establishment-type filters (kept in the URL), a **"Todas as
  Clínicas"** cross-clinic view for a caller with access to more than one, client-side
  pagination, and a CSV export of the filtered rows.
- **Dedicated create / edit / read-only view pages** (`/admin/units/new`, `/admin/units/:id`,
  `/admin/units/:id/edit`).
- **Rooms are derived, not a separate table** — a unit's room count is the number of distinct
  `roomLabel` values among its *non-retired* equipment; equipment counts include retired
  devices (still real inventory), rooms don't (a decommissioned scanner shouldn't keep a
  "room" occupied in the count).
- **Retire / return a unit to service** (`deactivatedAt`) — the "delete" action, since there
  is deliberately no hard delete (the same reasoning as equipment retirement). Retiring a
  unit blocks new teleoperation sessions on **all of its equipment**, without touching any
  device's own independent retirement flag — reactivating the unit later never silently
  un-retires equipment someone retired for an unrelated reason in between.
- **Edit a unit's settings** after creation, including reassigning or unassigning its
  technical manager. A unit's clinic is fixed at creation and cannot be changed by an edit.

### Audit trail
- **Hash-chained, append-only** — enforced by a database trigger that blocks `UPDATE`/
  `DELETE` on the audit table regardless of which role or connection touches it, not just by
  application-level convention.
- **Two-tier durability**: critical events (login, MFA, session start/end, takeover,
  lock/unlock, permission-denied) are written synchronously — they can never be lost.
  High-frequency input (up to 60 HID events/sec/session) is buffered in Redis off the hot
  path and flushed every `AUDIT_FLUSH_INTERVAL_MS` (5s default), so a Redis restart loses at
  most seconds of the least compliance-critical category, never a critical row.
- **Every significant action recorded**: login/logout/MFA outcomes, session lifecycle,
  takeover/return-control, print-text (length and delivery status only, never the actual
  text), equipment/queue/user/tenant changes, and every permission-denied attempt.
- **One-click hash-chain verification** — a tampered row is caught immediately, and pinpoints
  the exact sequence number where the chain breaks.
- **Full audit log viewer** with deep links straight into a session's replay.

### User management (Clinic Admin) and clinic registration rules
- **The System Administrator (Platform Admin) registers Clinic Manager, Supervisor, and
  Nursing accounts; a Clinic Manager registers Nursing accounts.** Enforced server-side by
  `canGrantRole`/`ROLE_GRANTS` (`packages/shared/src/roles.ts`), not just hidden client-side
  — the role dropdown only ever offers what the caller may actually grant.
- **A Manager (Clinic Admin) is linked to one or more clinics; a Supervisor is linked to the
  clinic(s) of a responsible Manager** — a real many-to-many `UserClinicMembership`, not a
  single tenant. Linking a Supervisor to a clinic requires that clinic to already have a
  Clinic Manager; a non-Platform-Admin caller may only link clinics they themselves belong
  to. A multi-clinic account's JWT carries one *active* clinic at a time (its "home" tenant,
  defaulting to the first one selected at registration) — see the clinic switcher below.
- **Invitation-based onboarding, not an admin-typed temp password.** `POST /users` no longer
  accepts a password at all: it creates the account and emails a secure, single-use,
  24-hour activation link (`SendInvitationHandler`); the new person chooses their own first
  password at `/ativar-conta` and self-enrolls MFA on their own first login afterward. An
  account that hasn't redeemed its invitation cannot log in (`isActivated()`), and a
  password-reset request against it is a silent no-op, same as a locked account. Admins can
  resend a lost/expired invitation from the user list.
- **List users**, in pt-BR, with each account's name, role, professional registration
  (free-text, e.g. "CRBM 14.820"), MFA-enrollment status, invitation status (pending vs.
  activated), and whether it's awaiting a forced password change.
- **Lock/unlock** an account and **force a password reset**, both effective immediately — a
  forced reset also revokes every existing session and requires the next login to change the
  password in-band (see "Enforced password policy..." above).
- **Switch active clinic** (`POST /auth/active-clinic`) — a multi-clinic account re-mints its
  token pair against a different clinic it's linked to, without a full re-login;
  `GET /auth/me/clinics` lists every clinic it can switch into. Revoking a clinic membership
  takes effect on that account's very next token refresh, not just its next login.
- **A read-only "what this role can do" summary** appears under the role picker while
  creating a user (`RolePermissionSummary`, driven by `ROLE_CAPABILITIES` in
  `packages/shared`) — every capability listed maps to a real, already-enforced `@Roles`
  decorator elsewhere in the app; there is no separate grant model behind it, and nothing
  invented (a couple of the roles the original design mock showed as checkboxes —
  "productivity reports," "incident supervision" — don't correspond to any real feature in
  this app, so they aren't listed).

### The console shell
Dashboard, **Manage users**, **Manage units**, **Manage equipment**, and **Manage clinics**
all share one light-themed sidebar+topbar layout (`ConsoleShell`) — a nav list
gated by role (`lib/nav-permissions.ts`, the one place those role sets are computed now,
instead of three independent copies), an identity block, and a real equipment-health
aggregate in the topbar ("Equipamentos: 6/8 online," scoped to the caller's active clinic —
not a fabricated status pill). `SessionPage`, `AuditPage`, `ClinicHomePage`, and
`LatencyClockPage` deliberately keep their own separate layouts; different concerns, not
part of this shell.

### Clinics, units, and the operator relationship
- **A clinic and an operator company are both `Tenant`s** (`CLINIC` vs. `OPERATOR_PROVIDER`).
  A clinic has patients and equipment; an operator company's staff remotely run that
  equipment. **One clinic has at most one operator tenant; one operator tenant can serve
  many clinics** — a nullable `Tenant.operatorTenantId` link, settable via
  `POST /tenants/:id/operator` (Platform Admin only). Creating or listing a clinic's units
  through the same operator link is real too: `ClinicAccessChecker` lets an Operator Admin
  act on a clinic their own operator tenant serves, the same way a Clinic Manager can act on
  a clinic they're a direct member of.
- **A clinic can have more than one Unit** ("like a hospital — a clinic/company can run more
  than one"), managed on its own **Manage units** page (`/admin/units`, same roles as
  equipment). Equipment belongs to a Unit (`Equipment.unitId`) — the create/edit equipment
  forms offer a picker sourced from the tenant's own units — so an operator's navigation is
  clinic → unit → equipment. Creating equipment without picking a unit auto-resolves to the
  clinic's oldest one, creating a default "Unidade Principal" on the fly if it has none yet;
  an equipment row is never left without one. Clinic-side user membership stays
  clinic-level, not unit-level: a Manager/Supervisor/Nursing account linked to a clinic can
  reach every one of its units.

### Clinic management (Platform Admin / superadmin)
- **Clinic registry** — register a clinic with its legal/institutional identity: CNPJ
  (validated against the real mod-11 check-digit algorithm, not just the 14-digit format,
  and rejected outright if it's a degenerate all-same-digit string), institutional e-mail,
  phone, and a full registered address (CEP, street, number, complement, district, city,
  state) — its own address block, deliberately separate from any of its Units' own (a clinic
  is the legal entity with one CNPJ and one registered address; a Unit is a physical site
  beneath it, and a clinic can have several). Every field above is required at registration;
  `type` and `cnpj` are **immutable after creation** — there is no `cnpj`/`type` field on the
  edit request at all, since correcting either would either re-parent a clinic's whole
  matriz/filial group or violate an invariant every role check assumes holds for a tenant's
  whole lifetime. Correcting a wrong CNPJ means registering a new clinic.
- **Matriz/filial, derived from the CNPJ itself, not a new relationship column** — a CNPJ's
  root (first 8 digits) identifies the group; branch order `0001` is the matriz, anything
  else a filial (`packages/shared/src/cnpj.ts`). No separate "parent clinic" field exists or
  is needed.
- **Equipamentos/unidades/modalidades are always derived, never re-entered** — a clinic's
  equipment count, unit count, and the distinct exam modalities across its (non-retired)
  equipment are computed server-side (`PrismaTenantRepository.summarizeClinics`) from the
  same `Equipment`/`Unit` rows those features already own. The clinic form has no equipment
  or modality section at all — that data already lives, and is edited, exactly one place
  each.
- **Listing screen** with summary counts (total, active, matrizes/filiais, equipment linked,
  managers allocated), free-text search across name/CNPJ/manager, status + modality filters
  (kept in the URL), client-side pagination, and a CSV export of the filtered rows.
- **Dedicated create / edit / read-only view pages** (`/superadmin/clinics/new`,
  `/superadmin/clinics/:id`, `/superadmin/clinics/:id/edit`) — reshaped from an earlier,
  single-name-field "create tenant" form into the same three-section pattern the
  equipment/unit registries use.
- **Responsible manager is optional at creation, assignable only on edit** — a brand-new
  clinic has no users yet to pick from (`CreateTenantRequestSchema` doesn't even accept
  `responsibleManagerId`), so the create form shows a note pointing at Gestores & Usuários
  instead of an empty picker. Eligibility is narrower than a Unit's technical manager: only
  an already-registered **`CLINIC_ADMIN`** of that same clinic, activated and not locked
  (`ResponsibleManagerValidator`) — a Unit accepts three roles, a clinic's overall manager
  only one.
- **Deactivate/reactivate a clinic** (`deactivatedAt`) — unchanged from the original tenant
  lifecycle: immediately locks out (or restores) every one of its users' ability to log in,
  deliberately never a real delete (a clinic's own append-only audit history would otherwise
  have to go with it). No deactivation cascade to its equipment/units was needed here —
  `LoginHandler`/`RefreshTokensHandler` already reject a deactivated tenant's users outright.
- **`GET /tenants` still returns every tenant type unchanged** (CLINIC, OPERATOR_PROVIDER,
  and the one PLATFORM tenant) — only this feature's own listing page narrows to CLINIC;
  the Units and Users pages' own clinic pickers, and `AdminUsersPage`'s tenant picker, all
  still depend on the unfiltered list.
- **Bootstrap a new tenant's first admin from outside it** via a tenant picker only a
  Platform Admin sees; every other role stays confined to its own tenant no matter what it
  sends.
- **No cross-tenant "god view"** — a Platform Admin's own user/equipment lists stay scoped to
  their own (platform) tenant, same as anyone else; tenant lifecycle and provisioning are in
  scope, browsing another tenant's day-to-day data is not.
- The **first superadmin account has no HTTP endpoint at all** — created only by a
  standalone, idempotent script (`make bootstrap-superadmin`), safe to re-run.

### Accessibility
Verified with `axe-core` against a live, running app in headless Chromium — not a manual
read-through — across every page, via a real repeatable test tier
(`apps/web/tests/a11y/pages.a11y.spec.ts`, `pnpm --filter @crop/web test:a11y`), logged in
through the real (mandatory-2FA) auth flow against the same no-hardware demo stack `make demo`
starts. Deliberately local/on-demand only, not wired into `.github/workflows/ci.yml` — see
`apps/web/playwright.config.ts`'s docstring for why.
- **Proper landmark and heading structure** on every page (`<header>`/`<main>`, exactly one
  `<h1>`, a real `h1 > h2 > h3` order) — screen reader users get a real "start of content"
  landmark and page title everywhere, not just on some pages.
- **Every form input has a real associated `<label>`** (`htmlFor`/`id`, not an unlinked
  sibling or a placeholder standing in for one) — login, MFA, "type text," and the session
  replay scrubber included.
- **Visible keyboard-focus indicator** on every interactive element, including the console
  capture zone.
- **Live-region announcements** (`role="alert"`/`role="status"`/`aria-live`) on error
  banners, the takeover banner, and connection-status changes, so a screen reader announces
  them when they change instead of requiring a sighted user to be looking at the right
  moment.
- **Every initial data load has a real error state** with a Retry action, not just a
  `finally` clearing a loading flag — a failed fetch used to leave some pages stuck on
  "Loading…" forever.
- **Responsive layout** below 900px (the dashboard/audit/session-metadata views collapse to
  a single column) — the console view itself is the one deliberate exception, since it
  fundamentally needs a real pointer and physical keyboard, the same as any browser-based
  remote-KVM tool.

### Observability
- **Structured JSON logs** (`pino`), every line tagged with the originating request's
  correlation id.
- **Prometheus metrics** at `/metrics`, including this platform's own input-processing
  overhead, active-session count, audit-flush timing, and per-equipment PiKVM connection
  errors.
- **A load-testing script** driving real concurrent Socket.io sessions at a configurable
  input rate against the real running API.

### Demoable without any real PiKVM hardware
A protocol-conformance mock (`pnpm spike:mock` / `make demo`) speaks PiKVM's actual HTTP+WS
protocol well enough that login, sessions, HID input, takeover, print-text, the patient
queue, equipment health, and the full audit trail all work end to end against it — only real
video decode doesn't (see `docs/architecture.md`). Everything in this README's demo script
runs this way.

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
with Node for fast iteration and straightforward debugging during a live demo. `make demo`
(see below) wraps all of this into one command.

Deploying somewhere shareable instead of running locally? See `DEPLOY.md` --
`apps/api/Dockerfile` and `infra/spike/Dockerfile` containerize the API and the mock PiKVM
respectively (both built and verified locally with `docker build`/`docker run`, including
correctly handling `argon2`'s native build step, which needs `python3`/`make`/`g++` present
at install time or it fails outright on a slim base image -- see that Dockerfile's own
comments).

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

**No PiKVM hardware available?** Run the mock instead (a separate terminal, kept running) --
or skip straight to `make demo` (step 8 below), which does exactly this for you:

```bash
pnpm spike:mock   # http://localhost:8443, plain HTTP -- see infra/spike/mock-pikvm-server.ts
```

then seed against it:

```bash
SEED_PIKVM_HOST=http://localhost:8443 SEED_PIKVM_USER=admin SEED_PIKVM_PASSWORD=admin pnpm db:seed
```

Everything works end to end this way — login/MFA, equipment health-polling to ONLINE,
sessions, HID input, takeover, return-control, print-text, the patient queue, the full audit
trail — except the video panel, which will correctly show a decode error (the mock sends
fake frame bytes to exercise the protocol, not real, decodable H.264 — see the mock's own
docstring). If you restart with a fresh mock/seed and equipment ever gets stuck reporting
"already has an active session" for no visible reason, see docs/architecture.md's note on
queue-entry lifecycle — likely fixed already, but worth knowing about if it recurs.

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

### 8. Or skip all of the above: `make demo`

Every step above (steps 2-6, against the mock PiKVM) is wrapped in a `Makefile` for
day-to-day use. `make help` lists everything; the ones you'll actually reach for:

```bash
make demo          # infra + mock PiKVM + API + web, all in the background, no hardware needed
make totp           # email + password + a *currently valid* TOTP code for every seeded user
make demo-status    # is everything still up?
make demo-logs       # tail all three background logs together
make demo-stop       # stop the background processes (infra containers keep running)
```

`make demo` is idempotent — re-running it skips any step that's already done (infra already
up, database already seeded, a server already listening on its port), so it's safe to run
again after a reboot or if one process died. `make totp` reads TOTP secrets live from the
database and computes a fresh code every time it's run, rather than reusing whatever
`db:seed` printed once at seed time (those codes are stale within 30 seconds, and the
secrets themselves scroll off-screen long before a demo is over).

Everything else — `make up`/`down`, `make migrate`/`reset-db`, `make seed` (against real
hardware) / `make seed-mock`, `make build`/`typecheck`/`lint`/`test`/`test-e2e`, `make
psql`/`redis-cli` — maps directly to the commands in the steps above; `make help` documents
each one inline.

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
pnpm --filter @crop/shared test   # coordinate math, modifier remap, hash chain, clinic-day/timezone math, queue contracts (incl. the tamper-detection case)
pnpm --filter @crop/pikvm test    # auth/TOTP building, stuck-key release tracking, no-crash-on-connection-error
pnpm --filter @crop/api test:e2e  # tenant isolation, RBAC, session/WS-gateway lifecycle, auth hardening + takeover + the full nursing queue surface, against real Postgres/Redis
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
| **A queue entry, once attached to any session — successful, ended, or aborted — could never be attached to a new one, but nothing ever moved it off `WAITING`**, so the dashboard kept re-selecting the same stuck patient forever | Running a live demo and hitting a persistent "Equipment already has an active session" error that a fresh `curl` request against the same equipment proved false | Starting a *second* session for any equipment that had ever served a patient failed permanently, mislabeled with an error message pointing at the wrong subsystem entirely |
| `infra/` scripts (`seed.ts`, spike/loadtest scripts) have zero typecheck coverage anywhere in this monorepo's toolchain | A `CreateEquipmentCommand`/`CreateQueueEntryCommand` signature change from the cleanup pass broke `seed.ts`, silently, since it's a direct `CommandBus` caller no `tsc` pass ever checks | The regression was invisible to `pnpm typecheck`/`build`/the full e2e suite and only surfaced when `pnpm db:seed` was actually run |
| "Type text" cleared itself with zero success feedback, indistinguishable from doing nothing (worse paired with the mock PiKVM's permanently-black video panel) | User-reported while demoing; confirmed via the audit trail that it had, in fact, always worked | Purely a UX gap, not a functional bug — now shows a transient "✓ Sent to equipment" confirmation |
| **The dashboard had no admin UI at all** — CLINIC_ADMIN saw the identical screen every other role saw, no way to list/create users or add equipment through the UI | User-reported while demoing ("how does admin work?") | `GET/POST /users`, admin-facing lock/unlock/reset-password, equipment creation, and patient-queue management (add/cancel) were all either fully implemented server-side with zero frontend caller, or missing entirely (no way to *list* users to act on) |
| `POST /queue/:id/status` returned HTTP 201 with a completely empty body instead of 204, unlike every other "do a thing, no return value" endpoint in this codebase | Giving that route its first-ever caller from an actual browser, while building the queue-management UI above | `supertest`'s `.expect(201)` never noticed (doesn't check for a body); a real browser's `fetch().json()` throws outright on an empty 2xx body — the new UI hit this immediately |
| **Equipment had create-only lifecycle** — no edit, and `EquipmentStatus.MAINTENANCE` existed in the shared enum from day one but nothing anywhere ever set it | A full backend↔frontend coverage audit ("check if we're missing anything"), cross-referencing every route/WS event against every frontend caller | Users got lock/unlock, Tenants got deactivate/reactivate, but a typo'd PiKVM host or a device pulled for repair had no fix except direct DB access |
| `RT_EVENTS.QUEUE_UPDATED`/`EQUIPMENT_STATUS_CHANGED` existed as constants from the start, emitted and listened for by nothing | Same audit | Two simultaneous dashboards only ever saw each other's queue/equipment changes after a manual reload — correct data, just never live |

Codebase cleanup pass added: the queue tenant-isolation fix above plus everything in the two
rows after it, a CORS-default drift between the HTTP server and the WebSocket gateway, a
keymap free-text field now validated against PiKVM's real supported list, an equipment
config option (`MouseMode.RELATIVE`) that looked selectable but had zero implementation
anywhere in the input pipeline (now rejected until it's actually built), and three genuinely
dead `AuditAction` values removed outright rather than forced into service — see
`docs/architecture.md` for the full list, including what was investigated and found clean.

Demoed without real PiKVM hardware using `infra/spike/mock-pikvm-server.ts` (a real
protocol-conformance test double, `pnpm spike:mock`) — everything works end to end except
actual video decode, which the mock deliberately never attempts to fake realistically. Found
the queue/session bug above, plus the `infra/` typecheck gap and the "Type text" feedback
gap, while running exactly that demo — see `docs/architecture.md`.

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
1. **Login + mandatory 2FA** — log in as `operator@central.crop.health`, enter the TOTP code.
   This account belongs to **Operadora Central**, the operating company — not to a clinic. It
   reaches a clinic's equipment only by switching into that clinic's context, which an
   accepted operator link authorizes; `GET /equipment` returns nothing until it does, because
   the operating company owns no equipment of its own.
1a. **Password reset** — from the login screen, click "Esqueci a senha", enter
    `operator@central.crop.health`, submit. With no real mail provider configured, the "email"
    is appended to `apps/api/storage/mail-outbox.jsonl` as JSON — open it and copy the
    `token=` value out of the link, or just visit the printed link directly if you set
    `APP_PUBLIC_URL` to match your dev server. Confirm the new password on the same page's
    "Nova Senha" tab, then log in with it — same 2FA step as always, since the reset link
    alone never bypasses it.
2. **Dashboard** — equipment list scoped to the operator's tenant, patient queue per machine.
3. **Start a session** — console view opens; the latency HUD shows measured input RTT, and
   the room camera PiP appears if `cameraUrl` is configured (step 7 above).
4. **Type a patient ID** — via the print-text field, not per-keystroke, so accented
   characters (`pt-br` keymap) render correctly.
5. **Takeover** — open a second browser as `supervisor@central.crop.health`, join the same
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
10. **Tenant isolation** — two halves now, since operators and clinics live in different
    tenants. Clinic side: log in as `enfermagem@alpha.crop.health` (Alpha's nurse) — Clinica
    Beta is not even offered as a clinic she can switch into, and Beta's equipment, sessions
    and audit log are invisible. Operator side: as `operator@central.crop.health`, switch into
    Alpha and then Beta, and note that each context shows only that clinic's equipment and
    queue — one account, two clinics, no leakage between them.
11. **Admin: manage users and equipment** — log in as `admin@alpha.crop.health`. "Manage
    users" and "Manage equipment" buttons appear (operators and supervisors never see
    these). Create a new NURSING account (the only role a Clinic Manager may grant --
    `CLINIC_ADMIN` here can't offer itself, a Supervisor, or an Operator in the dropdown at
    all) linked to Clinica Alpha: no password to relay -- a secure, 24-hour activation link
    is emailed instead (check `apps/api/storage/mail-outbox.jsonl` since there's no real
    mail provider by default). Open the link, choose a password, and log in as that new user
    in a second browser: their *own* first login walks them through 2FA enrollment via the
    same flow every seeded account went through, automatically, with nothing admin-specific
    required from that side at all.
11a. **Forced password change** — still logged in as `admin@alpha.crop.health`, click "Redefinir
     senha" next to any user and set a temporary password (the live strength meter and policy
     checklist reject anything too weak or containing that user's own name/email before you
     can even submit). Log in as that user in a second browser with the temp password: after
     entering their TOTP code, instead of landing on the dashboard they're routed straight
     into "Definir nova senha" — the same rich screen (stepper, whose-account identity card,
     countdown) the emailed reset link uses — and must set a password that isn't the one an
     admin just set for them before a real session is minted. Try reusing the temp password:
     rejected as a reuse, not just a weak-password error.
12. **Superadmin: manage tenants** — bootstrap one first (`make bootstrap-superadmin`, or
    `pnpm bootstrap:superadmin` — safe to re-run, no-ops if one already exists), then log in
    as it. A "Manage tenants" button appears that CLINIC_ADMIN never sees — create a new
    clinic, then head to "Manage users": choosing "Gestor de Clínica" (CLINIC_ADMIN) now
    shows a clinic checklist (invisible to everyone but PLATFORM_ADMIN for this role) to
    bootstrap that new clinic's first Manager from outside it. Deactivate the tenant — that
    Manager immediately loses the ability to log in; reactivate it and they're back. Notice
    "Manage tenants" itself never shows another tenant's equipment/sessions/audit log —
    tenant lifecycle only, no cross-tenant browsing.
13. **Equipment lifecycle** — on "Manage equipment," edit MRI-01 (rename it, tweak its
    screen size) and click "Enter maintenance." The dashboard's badge flips to a new
    MAINTENANCE color and "Start session" disables, same as OFFLINE/DEGRADED — walk away for
    10+ seconds and confirm it *doesn't* silently revert on its own (the health poller skips
    equipment currently in maintenance). "Clear maintenance" to bring it back.
14. **Live push, no reload** — open the dashboard in two separate browser windows, logged in
    as the same tenant's admin in both. Add a patient to the queue in one window; watch it
    appear in the other without ever refreshing it.


## What's out of scope for this MVP

See "What's intentionally not built" in `docs/architecture.md`. In short: ATX power control
and virtual USB mass storage are not implemented at all (clinical-safety and PHI reasons,
not a permission toggle), and several PiKVM web-UI conveniences (mouse sensitivity sliders,
CapsLock LED sync, the modifier-hold shortcut composer) were left out as polish that doesn't
affect correctness or safety within a 30-day timeline.

Also out of scope: a real per-permission *grant* model -- the create-user screen's role is
real and enforced, and now shows a read-only "what this role can do" summary
(`RolePermissionSummary`, derived from `ROLE_CAPABILITIES`), but there's still no separate
"revoke this one capability from this one person" grant beneath the role itself; and
unit-level (as opposed to clinic-level) membership scoping -- a Manager/Supervisor/Nursing
account linked to a clinic can reach every one of its units, there's no way to restrict one
to a subset.
