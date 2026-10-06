/** Tenant classification. */
export enum TenantType {
  CLINIC = "CLINIC",
  OPERATOR_PROVIDER = "OPERATOR_PROVIDER",
  PLATFORM = "PLATFORM",
}

/**
 * Application-level roles. Distinct from PiKVM, which has no role concept at all.
 *
 * Grouped by the *type* of tenant a role can belong to (see `ROLE_TENANT_TYPES` in
 * `roles.ts`, the single place that invariant is defined):
 *   - PLATFORM_ADMIN                                    -> PLATFORM tenants only
 *   - CLINIC_ADMIN, LOCAL_SUPERVISOR, NURSING, LOCAL_IT  -> CLINIC tenants
 *   - OPERATOR_ADMIN, OPERATIONAL_SUPERVISOR, OPERATOR   -> OPERATOR_PROVIDER tenants
 *   - AUDITOR                                            -> CLINIC or OPERATOR_PROVIDER
 *
 * `SUPERVISOR` was renamed to `OPERATIONAL_SUPERVISOR` (see the `role_model_expansion`
 * migration's `ALTER TYPE ... RENAME VALUE`) once the clinic side got its own, distinct
 * `LOCAL_SUPERVISOR` -- keeping one bare `SUPERVISOR` once there were two kinds would have
 * been ambiguous about which side of the business a given user's permissions came from.
 */
export enum UserRole {
  PLATFORM_ADMIN = "PLATFORM_ADMIN",
  CLINIC_ADMIN = "CLINIC_ADMIN",
  LOCAL_SUPERVISOR = "LOCAL_SUPERVISOR",
  NURSING = "NURSING",
  LOCAL_IT = "LOCAL_IT",
  OPERATOR_ADMIN = "OPERATOR_ADMIN",
  OPERATIONAL_SUPERVISOR = "OPERATIONAL_SUPERVISOR",
  OPERATOR = "OPERATOR",
  AUDITOR = "AUDITOR",
}

export enum EquipmentStatus {
  ONLINE = "ONLINE",
  OFFLINE = "OFFLINE",
  DEGRADED = "DEGRADED",
  MAINTENANCE = "MAINTENANCE",
}

/** Operating system running on the *controlled* (clinical) machine, not the operator's browser. */
export enum TargetOs {
  WINDOWS = "WINDOWS",
  MACOS = "MACOS",
  LINUX = "LINUX",
}

export enum MouseMode {
  ABSOLUTE = "ABSOLUTE",
  RELATIVE = "RELATIVE",
}

/**
 * The kind of exam a piece of equipment performs -- its clinical identity, as opposed to
 * `TargetOs`/`MouseMode` above, which describe the console this platform drives remotely.
 * Also what a `Unit` declares itself equipped for (`Unit.declaredModalities`) -- a plan,
 * which can precede the actual hardware arriving, and is shown alongside a unit's real
 * equipment rather than merged with it, so a mismatch between "declared" and "installed" is
 * visible instead of silently reconciled.
 *
 * A closed enum rather than free text so the equipment listing screen's modality filter and
 * its per-modality counts ("RM: 18  TC: 16  USG: 14") are computed from a known set instead
 * of from whatever strings happened to be typed. `XRAY` was added alongside the unit
 * registration feature, whose "Modalidades Instaladas" picker needs it -- adding a member
 * here is deliberately a schema migration plus a UI label, not a free-text field, so nobody
 * can silently introduce a modality neither listing screen has a counter for. Every
 * `Record<ExamModality, ...>` in `apps/web/src/lib/equipment-display.ts` had to grow a
 * fourth entry when `XRAY` was added -- `tsc` enforcing that the equipment screen's radio
 * cards, filter, and per-modality counter can't quietly miss a case.
 *
 * The values are English identifiers; their pt-BR abbreviations (RM / TC / USG / RX) live in
 * the web app's own translation file, not here -- see apps/web/src/i18n/locales/pt-BR.ts.
 */
export enum ExamModality {
  MRI = "MRI",
  CT = "CT",
  ULTRASOUND = "ULTRASOUND",
  XRAY = "XRAY",
}

/**
 * The kind of facility a `Unit` is -- required by the registration screen and filterable on
 * the listing screen, so (like `ExamModality`) a closed set rather than the free text
 * `User.professionalRegistration` uses for an unspecified taxonomy: the listing screen's
 * TIPO filter needs a reliable set of values to offer, not whatever text an operator typed.
 */
export enum EstablishmentType {
  LABORATORY = "LABORATORY",
  IMAGING_CENTER = "IMAGING_CENTER",
  HOSPITAL = "HOSPITAL",
  CLINIC = "CLINIC",
  URGENT_CARE = "URGENT_CARE",
  MOBILE_UNIT = "MOBILE_UNIT",
}

export enum SessionStatus {
  PENDING = "PENDING",
  ACTIVE = "ACTIVE",
  ENDED = "ENDED",
  ABORTED = "ABORTED",
}

export enum QueueStatus {
  WAITING = "WAITING",
  IN_PROGRESS = "IN_PROGRESS",
  DONE = "DONE",
  CANCELLED = "CANCELLED",
}

/**
 * The lifecycle of a contract between a clinic and an operating company (`OperatorAgreement`).
 * Either side may propose; only the *other* side may accept or reject, which is what makes it
 * an agreement rather than a unilateral grant.
 *
 * `REJECTED` and `REVOKED` are deliberately distinct, and neither is a deletion. A rejection
 * ended a proposal that never took effect; a revocation ended a contract that was live and
 * under which real sessions may already have been run. Collapsing them would destroy the one
 * question an auditor actually asks of a terminated contract -- was this clinic ever
 * operated by that company, and between which dates.
 *
 * Only `ACTIVE` grants access. There is no "suspended" state: a clinic that wants to stop an
 * operator immediately revokes, and re-proposing is cheap.
 */
export enum AgreementStatus {
  PENDING = "PENDING",
  ACTIVE = "ACTIVE",
  REJECTED = "REJECTED",
  REVOKED = "REVOKED",
}

/**
 * The nurse's in-room clinical preparation of a patient, tracked on the same `QueueEntry` as
 * `QueueStatus` but deliberately orthogonal to it -- the same split as `Equipment.status`
 * (health, poller-owned) vs `Equipment.deactivatedAt` (admin lifecycle). `QueueStatus` is the
 * exam-*slot* lifecycle, owned by session start/end (`StartSessionHandler`,
 * `EndSessionHandler`, `AbortIdleSessionHandler`); `PreparationStatus` is owned by the nurse's
 * three quick-action buttons and never touched by session code.
 *
 * `INJECTED` is deliberately skippable (`POSITIONED -> RELEASED` is a valid transition, not
 * just `POSITIONED -> INJECTED -> RELEASED`) -- the *domain* transition stays permissive on
 * purpose even now that `QueueEntry.contrastRequired` exists (see the queue-reorder/exam-
 * details feature): an exam that gets aborted mid-prep still has to let the patient go
 * regardless of whether contrast was ever due. What changed is only the nurse's UI, which
 * hides the "Injetado" button entirely when `contrastRequired` is false, rather than the
 * handler rejecting the transition -- a plain CT/ultrasound/X-ray exam's nurse never sees the
 * option, but nothing server-side would stop it if some future caller sent it anyway.
 * `NOT_STARTED` is a starting value only, never written by the API -- see
 * `UpdatePreparationStatusRequestSchema` in contracts/queue.ts.
 */
export enum PreparationStatus {
  NOT_STARTED = "NOT_STARTED",
  POSITIONED = "POSITIONED",
  INJECTED = "INJECTED",
  RELEASED = "RELEASED",
}

/**
 * Patient sex, recorded on `QueueEntry` as one of the nurse's editable exam-detail fields
 * (see the queue-reorder/exam-details feature). A closed enum for the same reason as
 * `ExamModality`/`EstablishmentType`: it drives a fixed set of UI labels, not free text.
 * Deliberately just three values, no `UNSPECIFIED` member -- the column itself is nullable,
 * which already covers "not recorded yet" without a redundant enum member for it.
 */
export enum PatientSex {
  FEMALE = "FEMALE",
  MALE = "MALE",
  OTHER = "OTHER",
}

/**
 * The nurse's pre-procedure allergy check, one of the three structured
 * "Questionário de Segurança & Contraste" facts (see the nursing day-view feature) alongside
 * `QueueEntry.fastingConfirmed`/`fastingHours` and `creatinineMgDl`. A closed two-value enum
 * rather than a boolean: `PRESENT` always requires reading `allergyNotes` for what the
 * allergy actually is, which a plain `true`/`false` would leave no natural place to attach
 * to that a nullable string on its own doesn't already communicate just as well -- kept as
 * an enum anyway (not "just use the notes field") so the "Alergias: Negadas"/"Alergias:
 * Registradas" card chip has a value to switch on instead of inferring state from whether a
 * free-text field happens to be empty.
 */
export enum AllergyStatus {
  NEGATED = "NEGATED",
  PRESENT = "PRESENT",
}

/**
 * What an uploaded `QueueEntryDocument` actually is -- the nurse picks this at upload time
 * (defaulting to `PEDIDO_MEDICO`, the common case). Exists so "the physician's order" and "a
 * prior report the patient brought in" are distinguishable in the document list; nothing
 * server-side branches on the value today.
 */
export enum QueueDocumentKind {
  PEDIDO_MEDICO = "PEDIDO_MEDICO",
  LAUDO_ANTERIOR = "LAUDO_ANTERIOR",
  OUTRO = "OUTRO",
}

/**
 * Every action that can produce an AuditLog row. Kept as a flat string enum (not free text)
 * so audit queries and compliance reports can rely on a closed set of values.
 *
 * Deliberately does NOT include an `MFA_SUCCESS` or `BLOCKED_ATX_ATTEMPT`/`BLOCKED_MSD_ATTEMPT`
 * -- all three existed here for a while but were never actually wired to anything, and none
 * of them turned out to have a real reason to exist. `LOGIN_SUCCESS` already *is* "MFA step
 * passed" (see VerifyMfaHandler's own comment: MFA is mandatory, so there is no meaningful
 * "logged in" moment that isn't also "passed MFA" -- a separate event would just duplicate
 * it). ATX/MSD control is never implemented at all, on purpose (see docs/architecture.md and
 * docs/pikvm-integration.md), so there is no code path that could ever emit a "blocked
 * attempt" at either -- keeping enum values for an attempt that can structurally never
 * happen is speculative dead weight, not forward-looking design.
 */
export enum AuditAction {
  LOGIN_SUCCESS = "LOGIN_SUCCESS",
  LOGIN_FAILURE = "LOGIN_FAILURE",
  LOGOUT = "LOGOUT",
  MFA_CHALLENGE_SENT = "MFA_CHALLENGE_SENT",
  MFA_FAILURE = "MFA_FAILURE",
  SESSION_START = "SESSION_START",
  SESSION_END = "SESSION_END",
  SESSION_ABORT = "SESSION_ABORT",
  TAKEOVER_REQUESTED = "TAKEOVER_REQUESTED",
  TAKEOVER_GRANTED = "TAKEOVER_GRANTED",
  RETURN_CONTROL_REQUESTED = "RETURN_CONTROL_REQUESTED",
  RETURN_CONTROL_GRANTED = "RETURN_CONTROL_GRANTED",
  INPUT_BATCH = "INPUT_BATCH",
  PRINT_TEXT = "PRINT_TEXT",
  HID_RESET = "HID_RESET",
  SNAPSHOT_CAPTURED = "SNAPSHOT_CAPTURED",
  EQUIPMENT_CREATED = "EQUIPMENT_CREATED",
  EQUIPMENT_UPDATED = "EQUIPMENT_UPDATED",
  // Retiring a scanner from service / returning it. Distinct from EQUIPMENT_UPDATED (an edit
  // to its record) and from the status transitions that also ride on EQUIPMENT_UPDATED (a
  // health change) -- "who took this device out of service, and when" is the question a
  // reviewer actually asks, and it should not require scanning a changedFields list to
  // answer. Mirrors the TENANT_DEACTIVATED/TENANT_REACTIVATED pair below.
  EQUIPMENT_DEACTIVATED = "EQUIPMENT_DEACTIVATED",
  EQUIPMENT_REACTIVATED = "EQUIPMENT_REACTIVATED",
  UNIT_CREATED = "UNIT_CREATED",
  // Mirrors the EQUIPMENT_UPDATED/DEACTIVATED/REACTIVATED trio above, for the same reasons:
  // an edit to a unit's own record is distinct from taking it out of service or returning it
  // to service, and the latter two should be answerable without scanning a changedFields list.
  UNIT_UPDATED = "UNIT_UPDATED",
  UNIT_DEACTIVATED = "UNIT_DEACTIVATED",
  UNIT_REACTIVATED = "UNIT_REACTIVATED",
  QUEUE_ENTRY_CREATED = "QUEUE_ENTRY_CREATED",
  QUEUE_ENTRY_UPDATED = "QUEUE_ENTRY_UPDATED",
  // The nurse's drag/arrow reordering of a room's WAITING patients (see ReorderQueueHandler).
  // One row per *reorder act* (a whole new sequence confirmed at once), not one per moved
  // entry -- mirrors PATIENT_POSITIONED/INJECTED/RELEASED's "one action, one row" shape, but
  // at the granularity the nurse's own "Confirmar Nova Sequência" button actually commits at.
  // `details` carries `previousOrder`/`newOrder` (queue entry ids only) -- never
  // patientFirstName, same PHI rule as every other queue audit row.
  QUEUE_REORDERED = "QUEUE_REORDERED",
  // The nurse's three quick-action buttons (see PreparationStatus above). Three granular
  // actions rather than one generic PATIENT_PREPARATION_UPDATED, mirroring the
  // EQUIPMENT_DEACTIVATED/REACTIVATED reasoning: "was this patient injected, and when" is a
  // question a reviewer actually asks, and it should not require reading a
  // previousPreparationStatus field out of a generic event's details to answer.
  PATIENT_POSITIONED = "PATIENT_POSITIONED",
  PATIENT_INJECTED = "PATIENT_INJECTED",
  PATIENT_RELEASED = "PATIENT_RELEASED",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  ACCOUNT_LOCKED = "ACCOUNT_LOCKED",
  ACCOUNT_UNLOCKED = "ACCOUNT_UNLOCKED",
  PASSWORD_RESET_BY_ADMIN = "PASSWORD_RESET_BY_ADMIN",
  PASSWORD_RESET_REQUESTED = "PASSWORD_RESET_REQUESTED",
  PASSWORD_RESET_COMPLETED = "PASSWORD_RESET_COMPLETED",
  PASSWORD_CHANGED = "PASSWORD_CHANGED",
  USER_CREATED = "USER_CREATED",
  // An edit to the user's own profile/role/clinic-membership record, mirroring the
  // identical TENANT_UPDATED/UNIT_UPDATED split -- distinct from ACCOUNT_LOCKED/UNLOCKED
  // (a lifecycle transition) and from PASSWORD_RESET_BY_ADMIN (a credential, not a profile,
  // change).
  USER_UPDATED = "USER_UPDATED",
  USER_INVITED = "USER_INVITED",
  USER_INVITE_RESENT = "USER_INVITE_RESENT",
  USER_ACTIVATED = "USER_ACTIVATED",
  ACTIVE_CLINIC_SWITCHED = "ACTIVE_CLINIC_SWITCHED",
  TENANT_CREATED = "TENANT_CREATED",
  // An edit to the clinic's own institutional/address/manager record -- distinct from
  // TENANT_OPERATOR_LINKED (a specific relationship change) and from
  // TENANT_DEACTIVATED/REACTIVATED (a lifecycle transition), mirroring the identical split
  // already established for UNIT_UPDATED vs UNIT_DEACTIVATED/REACTIVATED.
  TENANT_UPDATED = "TENANT_UPDATED",
  // Superseded by the AGREEMENT_* actions below, which replaced `Tenant.operatorTenantId`
  // with a real many-to-many `OperatorAgreement`. Kept because `audit_logs` is append-only
  // (enforced by a DB trigger, see the audit_append_only migration): historical rows
  // reference this action and nothing may rewrite them, so removing the enum member would
  // make already-written history unreadable. Never emitted by new code.
  TENANT_OPERATOR_LINKED = "TENANT_OPERATOR_LINKED",
  TENANT_DEACTIVATED = "TENANT_DEACTIVATED",
  TENANT_REACTIVATED = "TENANT_REACTIVATED",
  // The clinic<->operating-company contract lifecycle. Five actions rather than one generic
  // AGREEMENT_UPDATED, for the same reason EQUIPMENT_DEACTIVATED/REACTIVATED are split from
  // EQUIPMENT_UPDATED: "when did this company gain access to this clinic, who granted it, and
  // when was it withdrawn" are the questions actually asked of this record, and none of them
  // should require reading a previousStatus out of a generic event's details.
  //
  // Every one of these is recorded against the *clinic's* tenantId, not the operator's: the
  // clinic is the party whose data access is being changed, and its own audit log is where a
  // reviewer looks to answer "who could see our patients, and since when". The operator
  // tenant id travels in `details`.
  AGREEMENT_PROPOSED = "AGREEMENT_PROPOSED",
  AGREEMENT_ACCEPTED = "AGREEMENT_ACCEPTED",
  AGREEMENT_REJECTED = "AGREEMENT_REJECTED",
  AGREEMENT_REVOKED = "AGREEMENT_REVOKED",
  // A change to *which* units/equipment an active contract covers -- the narrowing that makes
  // an agreement mean something less than "all of this clinic". Separate from ACCEPTED
  // because scope is edited over the contract's life, long after it was agreed.
  AGREEMENT_SCOPE_CHANGED = "AGREEMENT_SCOPE_CHANGED",
  // The exam-support chat (`ExamMessage`) -- the real, persisted, tenant-scoped clinic<->
  // operator text channel `docs/architecture.md`'s "What's intentionally not built" section
  // used to say did not exist. One row per message, mirroring PRINT_TEXT's own "one action,
  // one row" shape: `details` carries the equipment/queue-entry ids and the message id, never
  // the message body itself -- the body is already durably stored on the `ExamMessage` row,
  // and duplicating free-text clinical content into the audit log's `details` JSON would be
  // exactly the kind of unbounded, ungoverned PHI copy this codebase has avoided everywhere
  // else (see QUEUE_REORDERED's own docstring on recording ids, never patient names).
  EXAM_MESSAGE_SENT = "EXAM_MESSAGE_SENT",
  // Creating a canned quick-reply (`MessageShortcut`) for the active clinic's chat.
  MESSAGE_SHORTCUT_CREATED = "MESSAGE_SHORTCUT_CREATED",
  // Uploading/removing a `QueueEntryDocument` (the nurse's "Pedido Médico"/"Laudo Anterior"
  // upload) -- same "ids and metadata only" rule as EXAM_MESSAGE_SENT above: `details` carries
  // `kind`/`mimeType`, never `filename`, since a clinician-chosen filename can itself carry a
  // patient's name. Two actions, not one generic QUEUE_DOCUMENT_CHANGED, for the same
  // reviewer-legibility reason PATIENT_POSITIONED/INJECTED/RELEASED are three rows instead of
  // one: "was a document removed, and when" should not require re-deriving it from a
  // before/after diff.
  QUEUE_DOCUMENT_ATTACHED = "QUEUE_DOCUMENT_ATTACHED",
  QUEUE_DOCUMENT_REMOVED = "QUEUE_DOCUMENT_REMOVED",
  // Retired: the push-to-talk intercom feature (`IntercomChannel`, presence-only, no audio
  // ever rode on it) was removed wholesale -- the gateway handlers, the in-memory presence
  // registry, and the contracts are all gone. Kept here only because `audit_logs` is
  // append-only (enforced by a DB trigger, see the audit_append_only migration): any row a
  // completed PTT hold produced before removal still references this action, and nothing may
  // rewrite it. Never emitted by any code that exists today -- mirrors
  // `TENANT_OPERATOR_LINKED`'s identical "superseded, unremovable" status above.
  INTERCOM_PTT = "INTERCOM_PTT",
}
