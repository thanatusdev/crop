import { UserRole } from "./enums.js";

/**
 * A capability key is only added here once a real, enforced `@Roles` decorator backs it --
 * this is display-only (see `RolePermissionSummary.tsx`, the create-user form's read-only
 * "what this role can do" list), but it must never claim a capability that doesn't exist.
 * The mock this feature was built from showed "Relatórios de Produtividade" ("productivity
 * reports") and "Supervisão de Intercorrências" ("incident supervision") as two of its three
 * example checkboxes -- neither corresponds to any real feature anywhere in this codebase
 * (there is no reports feature, no incident/intercorrência feature at all), so neither
 * appears here. Every key below is one specific, real, already-enforced capability instead.
 */
export type RoleCapabilityKey =
  | "tenant_management"
  | "user_management_clinic"
  | "user_management_clinic_staff"
  | "user_management_operator"
  | "equipment_management"
  | "queue_management"
  | "session_supervision"
  | "session_operation"
  | "audit_access"
  | "audit_access_readonly"
  | "all_above";

/**
 * What each role can actually do today, derived directly from each controller's own
 * `@Roles` decorator (TenantsController, UsersController/`ROLE_GRANTS`, EquipmentController,
 * UnitsController, QueueController, SessionsController's takeover/return-control routes,
 * AuditController) -- not aspirational, and nothing here is enforced by this list itself;
 * it only describes what other, real checks already allow.
 *
 * The two clinic user-management keys are deliberately distinct rather than one shared key:
 * the whole difference rule #6 draws between a manager and a supervisor is *which* accounts
 * they may create, so collapsing them would make this list claim a supervisor can appoint
 * managers. `user_management_clinic` = every clinic role (including another manager);
 * `user_management_clinic_staff` = nursing and local IT only. Both are backed by
 * `ROLE_GRANTS` plus `UsersController`'s `@Roles`.
 *
 * `equipment_management` moved off `OPERATOR_ADMIN` and onto `LOCAL_SUPERVISOR` when
 * provisioning became clinic-only -- an operating company no longer registers a clinic's
 * scanners, so claiming it here would have been exactly the kind of unbacked assertion this
 * file's own docstring forbids.
 */
export const ROLE_CAPABILITIES: Record<UserRole, readonly RoleCapabilityKey[]> = {
  [UserRole.PLATFORM_ADMIN]: ["tenant_management", "all_above"],
  [UserRole.CLINIC_ADMIN]: ["user_management_clinic", "equipment_management", "queue_management", "audit_access"],
  [UserRole.LOCAL_SUPERVISOR]: [
    "user_management_clinic_staff",
    "equipment_management",
    "queue_management",
    "session_supervision",
    "audit_access",
  ],
  [UserRole.NURSING]: ["queue_management"],
  [UserRole.LOCAL_IT]: ["equipment_management"],
  [UserRole.OPERATOR_ADMIN]: ["user_management_operator", "queue_management", "audit_access"],
  [UserRole.OPERATIONAL_SUPERVISOR]: ["queue_management", "session_supervision", "audit_access"],
  [UserRole.OPERATOR]: ["session_operation"],
  [UserRole.AUDITOR]: ["audit_access_readonly"],
};
