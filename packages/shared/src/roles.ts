import { TenantType, UserRole } from "./enums.js";

/**
 * The single source of truth for which `TenantType`(s) a `UserRole` may belong to. Until this
 * file, nothing in the codebase validated a user's role against their tenant's type at all
 * (see docs/architecture.md) -- `RegisterUserHandler` is the first and only place this is
 * enforced, but every other place that needs to reason about "is this a clinic role or an
 * operator-side role" (seed scripts, the admin create-user form, RegisterUserHandler itself)
 * should read it from here rather than re-deriving it.
 *
 * OPERATOR_ADMIN/OPERATIONAL_SUPERVISOR/OPERATOR are OPERATOR_PROVIDER-only. **This
 * reverses the original decision**, which allowed them in a CLINIC tenant too; the reversal
 * is the whole point of this change, so the reasoning on both sides is worth recording.
 *
 * The original argument was purely pragmatic: `Equipment`/`Session`/`QueueEntry` are
 * single-tenant-scoped everywhere (30 `belongsToTenant` call sites), so the only
 * *functional* way for an operator to run a clinic's equipment was to belong to that same
 * CLINIC tenant -- which is exactly how the seed modelled it (operator@alpha.crop.health
 * lived inside Clinica Alpha). OPERATOR_PROVIDER existed as a tenant type but was wired to
 * no equipment of its own, and narrowing these roles then would have broken every operator
 * account with nothing to replace it.
 *
 * The business model this platform actually implements is the opposite: a clinic contracts
 * one or more *separate* operating companies, and an operating company serves one or more
 * clinics (many-to-many, see `OperatorAgreement`). An OPERATOR employed by the clinic it
 * remotely operates is a contradiction in that model -- there is nobody to contract with.
 * So the role now lives where the employment relationship actually is, and cross-tenant
 * reach is granted by an accepted agreement rather than by co-tenancy.
 *
 * How the `belongsToTenant` problem is solved instead of worked around: a contracted
 * operator *switches into the clinic's context* (`SwitchActiveClinicHandler` mints a token
 * whose `tenantId` claim is the clinic), so every existing single-tenant check keeps
 * working unmodified, and agreement scope narrows *which* of that clinic's equipment they
 * may reach. Tenancy stays the coarse check; the agreement is the fine one.
 *
 * CLINIC_ADMIN/LOCAL_SUPERVISOR/NURSING/LOCAL_IT are CLINIC-only: they have no reason to
 * exist in an operator-provider or platform tenant. AUDITOR remains valid in either CLINIC
 * or OPERATOR_PROVIDER -- deliberately *not* narrowed alongside the operator-side roles,
 * because unlike them it exists to observe either side of the business rather than to
 * belong to one of them, and both a clinic and an operating company have a real need for
 * their own read-only auditor. PLATFORM_ADMIN is valid only in PLATFORM, mirroring the
 * exclusion already enforced by `CreateUserRequestSchema`.
 */
export const ROLE_TENANT_TYPES: Record<UserRole, readonly TenantType[]> = {
  [UserRole.PLATFORM_ADMIN]: [TenantType.PLATFORM],
  [UserRole.CLINIC_ADMIN]: [TenantType.CLINIC],
  [UserRole.LOCAL_SUPERVISOR]: [TenantType.CLINIC],
  [UserRole.NURSING]: [TenantType.CLINIC],
  [UserRole.LOCAL_IT]: [TenantType.CLINIC],
  [UserRole.OPERATOR_ADMIN]: [TenantType.OPERATOR_PROVIDER],
  [UserRole.OPERATIONAL_SUPERVISOR]: [TenantType.OPERATOR_PROVIDER],
  [UserRole.OPERATOR]: [TenantType.OPERATOR_PROVIDER],
  [UserRole.AUDITOR]: [TenantType.CLINIC, TenantType.OPERATOR_PROVIDER],
};

/**
 * Roles primarily associated with the clinic side of the business -- used for UI grouping
 * (e.g. which roles a CLINIC_ADMIN's "create user" form offers), not tenant-type enforcement;
 * see `ROLE_TENANT_TYPES` for the actual invariant.
 */
export const CLINIC_ROLES: readonly UserRole[] = [
  UserRole.CLINIC_ADMIN,
  UserRole.LOCAL_SUPERVISOR,
  UserRole.NURSING,
  UserRole.LOCAL_IT,
];

/**
 * Roles primarily associated with the remote-operation side of the business. Since the
 * role-model inversion these are *also* exactly the roles `ROLE_TENANT_TYPES` confines to
 * OPERATOR_PROVIDER tenants -- the grouping and the invariant now agree, where previously
 * this list was about who a role *is* and said nothing about where it may live. Keep them
 * separate anyway: `ROLE_TENANT_TYPES` is the enforced invariant, this is a UI grouping, and
 * AUDITOR is deliberately in neither (it spans both sides).
 */
export const OPERATOR_PROVIDER_ROLES: readonly UserRole[] = [
  UserRole.OPERATOR_ADMIN,
  UserRole.OPERATIONAL_SUPERVISOR,
  UserRole.OPERATOR,
];

/**
 * Every role assignable through `POST /users` -- i.e. everything except `PLATFORM_ADMIN`,
 * which is bootstrap-script-only (see `CreateUserRequestSchema`'s own docstring for why a
 * tenant-scoped PLATFORM_ADMIN is a contradiction in terms).
 */
export const ASSIGNABLE_ROLES: readonly UserRole[] = [
  UserRole.CLINIC_ADMIN,
  UserRole.LOCAL_SUPERVISOR,
  UserRole.NURSING,
  UserRole.LOCAL_IT,
  UserRole.OPERATOR_ADMIN,
  UserRole.OPERATIONAL_SUPERVISOR,
  UserRole.OPERATOR,
  UserRole.AUDITOR,
];

/** True if `role` is permitted to belong to a tenant of type `tenantType`. */
export function isRoleAllowedInTenantType(role: UserRole, tenantType: TenantType): boolean {
  return ROLE_TENANT_TYPES[role].includes(tenantType);
}

/**
 * Who may register whom, via `POST /users` -- narrower than `ASSIGNABLE_ROLES` (which is
 * just "every role that isn't bootstrap-only"). Enforced in `RegisterUserHandler` via
 * `canGrantRole`, not the controller, for the same reason `isRoleAllowedInTenantType` lives
 * there -- so seed scripts are covered too.
 *
 * The clinic-side rule is now "the Clinic Manager can do everything; the Local Supervisor
 * can do everything except create other Clinic Managers or Local Supervisors". So
 * `CLINIC_ADMIN` grants all four clinic roles, and `LOCAL_SUPERVISOR` grants the two
 * non-privileged ones (`NURSING`, `LOCAL_IT`). This widens an earlier, narrower reading
 * ("the Clinic Manager registers users with the Nursing profile", which had
 * `CLINIC_ADMIN: [NURSING]` and `LOCAL_SUPERVISOR: []`).
 *
 * Note `CLINIC_ADMIN` may now grant `CLINIC_ADMIN` -- the one role in this matrix that can
 * grant its own kind. That is intentional ("can do everything", and a clinic needs to be
 * able to appoint a second manager without calling the platform operator), but it is also
 * the matrix's only privilege-escalation-adjacent edge, so it is called out here rather than
 * left to be discovered. `LOCAL_SUPERVISOR` deliberately cannot grant its own kind, which is
 * the precise difference rule #6 draws between the two.
 *
 * `PLATFORM_ADMIN` keeps every assignable role. The operator-side grants are unchanged and
 * unaffected by the clinic-side rule: `OPERATOR_ADMIN` creates its own company's operators
 * and operational supervisors, and nothing clinic-side.
 *
 * A `null` actor (seed scripts / bootstrap-superadmin.ts, which dispatch
 * `RegisterUserCommand` directly through the `CommandBus`, bypassing HTTP and this check
 * entirely -- see `RegisterUserHandler`) is exempt, the same way `actingUserId: null` is
 * exempt from producing an attributed audit row.
 */
export const ROLE_GRANTS: Record<UserRole, readonly UserRole[]> = {
  [UserRole.PLATFORM_ADMIN]: [
    UserRole.CLINIC_ADMIN,
    UserRole.LOCAL_SUPERVISOR,
    UserRole.NURSING,
    UserRole.LOCAL_IT,
    UserRole.OPERATOR_ADMIN,
    UserRole.OPERATIONAL_SUPERVISOR,
    UserRole.OPERATOR,
    UserRole.AUDITOR,
  ],
  [UserRole.CLINIC_ADMIN]: [UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.NURSING, UserRole.LOCAL_IT],
  [UserRole.LOCAL_SUPERVISOR]: [UserRole.NURSING, UserRole.LOCAL_IT],
  [UserRole.NURSING]: [],
  [UserRole.LOCAL_IT]: [],
  [UserRole.OPERATOR_ADMIN]: [UserRole.OPERATIONAL_SUPERVISOR, UserRole.OPERATOR],
  [UserRole.OPERATIONAL_SUPERVISOR]: [],
  [UserRole.OPERATOR]: [],
  [UserRole.AUDITOR]: [],
};

/** True if `actor` may register a new account with `target`'s role. `actor === null` is
 * the seed-script/bootstrap exemption -- see `ROLE_GRANTS`'s own docstring. */
export function canGrantRole(actor: UserRole | null, target: UserRole): boolean {
  if (actor === null) return true;
  return ROLE_GRANTS[actor].includes(target);
}

/** Roles that must be linked to one or more clinics at registration time (rule: "A Manager
 * is linked to one or more clinics. A Supervisor is linked to the clinic(s) of the
 * responsible Manager."). Nursing is included too -- a clinic-side account with no clinic
 * at all can't reach anything. Operator-side and platform roles are unaffected; they keep
 * the single-`tenantId` model `RegisterUserCommand` already had. */
export const CLINIC_ASSIGNMENT_ROLES: readonly UserRole[] = [UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.NURSING];

export function requiresClinicAssignment(role: UserRole): boolean {
  return CLINIC_ASSIGNMENT_ROLES.includes(role);
}

/**
 * Every role that may read or write the exam-support chat (`ExamMessage`/`MessageShortcut`) --
 * `ChatController`'s own class-level `@Roles`, and (since the chat's realtime transport moved
 * to a socket room a client joins explicitly, see `RT_EVENTS.JOIN_EQUIPMENT_CHAT`'s own
 * docstring) `CanAccessEquipmentChatHandler`'s join check too. Shared between the two so a
 * role excluded from the REST surface can never join the room and sit there receiving live
 * broadcasts of a conversation it could not otherwise list. Every clinic/operator role except
 * `LOCAL_IT`, which has no legitimate reason to read patient-adjacent chat any more than it
 * does the patient queue itself -- there is no narrower business rule stated for who may use
 * this chat, so this reuses the queue's own answer (`QueueController`'s identical class-level
 * set) rather than inventing a second one.
 */
export const CHAT_ALLOWED_ROLES: readonly UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.CLINIC_ADMIN,
  UserRole.LOCAL_SUPERVISOR,
  UserRole.NURSING,
  UserRole.OPERATOR,
  UserRole.OPERATIONAL_SUPERVISOR,
  UserRole.OPERATOR_ADMIN,
  UserRole.AUDITOR,
];
