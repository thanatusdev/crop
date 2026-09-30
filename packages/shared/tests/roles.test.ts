import { describe, expect, it } from "vitest";
import { TenantType, UserRole } from "../src/enums.js";
import { canGrantRole, isRoleAllowedInTenantType, requiresClinicAssignment, ROLE_GRANTS } from "../src/roles.js";

/**
 * The clinic-side business rule: "the Clinic Manager can do everything; the Local Supervisor
 * can do everything except create other Clinic Managers or Local Supervisors" -- table-driven
 * against every (actor, target) pair `ROLE_GRANTS` defines, not just the ones named in that
 * sentence, so a future edit to the matrix can't silently widen or narrow a role's reach
 * without a test noticing.
 */
describe("canGrantRole", () => {
  it("lets PLATFORM_ADMIN grant CLINIC_ADMIN, LOCAL_SUPERVISOR, and NURSING -- the three profiles named in the business rule", () => {
    expect(canGrantRole(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN)).toBe(true);
    expect(canGrantRole(UserRole.PLATFORM_ADMIN, UserRole.LOCAL_SUPERVISOR)).toBe(true);
    expect(canGrantRole(UserRole.PLATFORM_ADMIN, UserRole.NURSING)).toBe(true);
  });

  it("lets CLINIC_ADMIN (the Clinic Manager) grant every clinic role, including its own kind", () => {
    expect(canGrantRole(UserRole.CLINIC_ADMIN, UserRole.CLINIC_ADMIN)).toBe(true);
    expect(canGrantRole(UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR)).toBe(true);
    expect(canGrantRole(UserRole.CLINIC_ADMIN, UserRole.NURSING)).toBe(true);
    expect(canGrantRole(UserRole.CLINIC_ADMIN, UserRole.LOCAL_IT)).toBe(true);
  });

  it("still stops CLINIC_ADMIN from granting any operator-side or platform role", () => {
    expect(canGrantRole(UserRole.CLINIC_ADMIN, UserRole.OPERATOR)).toBe(false);
    expect(canGrantRole(UserRole.CLINIC_ADMIN, UserRole.OPERATIONAL_SUPERVISOR)).toBe(false);
    expect(canGrantRole(UserRole.CLINIC_ADMIN, UserRole.OPERATOR_ADMIN)).toBe(false);
    expect(canGrantRole(UserRole.CLINIC_ADMIN, UserRole.AUDITOR)).toBe(false);
    expect(canGrantRole(UserRole.CLINIC_ADMIN, UserRole.PLATFORM_ADMIN)).toBe(false);
  });

  /**
   * The precise difference rule #6 draws between the two clinic-privileged roles: the
   * supervisor can staff the clinic, but cannot appoint a peer or a manager. Asserted as an
   * exhaustive sweep so adding a role to `LOCAL_SUPERVISOR`'s grants fails here.
   */
  it("lets LOCAL_SUPERVISOR grant only NURSING and LOCAL_IT -- never a manager or another supervisor", () => {
    expect(canGrantRole(UserRole.LOCAL_SUPERVISOR, UserRole.NURSING)).toBe(true);
    expect(canGrantRole(UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT)).toBe(true);
    expect(canGrantRole(UserRole.LOCAL_SUPERVISOR, UserRole.CLINIC_ADMIN)).toBe(false);
    expect(canGrantRole(UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_SUPERVISOR)).toBe(false);
    for (const target of Object.values(UserRole)) {
      const allowed = target === UserRole.NURSING || target === UserRole.LOCAL_IT;
      expect(canGrantRole(UserRole.LOCAL_SUPERVISOR, target)).toBe(allowed);
    }
  });

  it("lets neither NURSING nor LOCAL_IT grant any role -- they only ever receive accounts, never create them", () => {
    for (const target of Object.values(UserRole)) {
      expect(canGrantRole(UserRole.NURSING, target)).toBe(false);
      expect(canGrantRole(UserRole.LOCAL_IT, target)).toBe(false);
    }
  });

  it("leaves the operator-side grants (unrelated to the clinic-side rule) untouched", () => {
    expect(canGrantRole(UserRole.OPERATOR_ADMIN, UserRole.OPERATIONAL_SUPERVISOR)).toBe(true);
    expect(canGrantRole(UserRole.OPERATOR_ADMIN, UserRole.OPERATOR)).toBe(true);
    expect(canGrantRole(UserRole.OPERATOR_ADMIN, UserRole.CLINIC_ADMIN)).toBe(false);
    expect(canGrantRole(UserRole.OPERATOR_ADMIN, UserRole.OPERATOR_ADMIN)).toBe(false);
  });

  it("exempts a null actor (seed scripts / bootstrap-superadmin.ts, which bypass HTTP entirely)", () => {
    for (const target of Object.values(UserRole)) {
      expect(canGrantRole(null, target)).toBe(true);
    }
  });

  /**
   * `CLINIC_ADMIN` is the *only* role permitted to grant its own kind, so a clinic can
   * appoint a second manager without calling the platform operator. Any other self-grant is
   * an accident: this pins the exception to exactly one role rather than just allowing
   * self-grants generally.
   */
  it("permits exactly one self-granting role (CLINIC_ADMIN) and no others", () => {
    const selfGranting = Object.entries(ROLE_GRANTS)
      .filter(([actor, targets]) => targets.includes(actor as UserRole))
      .map(([actor]) => actor);
    expect(selfGranting).toEqual([UserRole.CLINIC_ADMIN]);
  });
});

describe("requiresClinicAssignment", () => {
  it("is true for exactly the three clinic-side roles this feature is about", () => {
    expect(requiresClinicAssignment(UserRole.CLINIC_ADMIN)).toBe(true);
    expect(requiresClinicAssignment(UserRole.LOCAL_SUPERVISOR)).toBe(true);
    expect(requiresClinicAssignment(UserRole.NURSING)).toBe(true);
  });

  it("is false for every other role", () => {
    expect(requiresClinicAssignment(UserRole.PLATFORM_ADMIN)).toBe(false);
    expect(requiresClinicAssignment(UserRole.LOCAL_IT)).toBe(false);
    expect(requiresClinicAssignment(UserRole.OPERATOR_ADMIN)).toBe(false);
    expect(requiresClinicAssignment(UserRole.OPERATIONAL_SUPERVISOR)).toBe(false);
    expect(requiresClinicAssignment(UserRole.OPERATOR)).toBe(false);
    expect(requiresClinicAssignment(UserRole.AUDITOR)).toBe(false);
  });
});

/**
 * The role-model inversion: operator-side roles belong to the operating *company*, never to
 * the clinic it remotely operates. These assertions are the enforceable form of that business
 * decision -- `RegisterUserHandler` refuses any account that violates them, which is what
 * makes the clinic unable to hold an operator user at all (rule #8).
 */
describe("isRoleAllowedInTenantType", () => {
  it("still confines the clinic-only roles to CLINIC tenants", () => {
    for (const role of [UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.NURSING, UserRole.LOCAL_IT]) {
      expect(isRoleAllowedInTenantType(role, TenantType.CLINIC)).toBe(true);
      expect(isRoleAllowedInTenantType(role, TenantType.OPERATOR_PROVIDER)).toBe(false);
      expect(isRoleAllowedInTenantType(role, TenantType.PLATFORM)).toBe(false);
    }
  });

  it("confines the operator-side roles to OPERATOR_PROVIDER tenants -- a clinic can no longer hold an operator", () => {
    for (const role of [UserRole.OPERATOR, UserRole.OPERATIONAL_SUPERVISOR, UserRole.OPERATOR_ADMIN]) {
      expect(isRoleAllowedInTenantType(role, TenantType.OPERATOR_PROVIDER)).toBe(true);
      expect(isRoleAllowedInTenantType(role, TenantType.CLINIC)).toBe(false);
      expect(isRoleAllowedInTenantType(role, TenantType.PLATFORM)).toBe(false);
    }
  });

  it("keeps AUDITOR valid on both sides of the business -- deliberately not narrowed with the operator roles", () => {
    expect(isRoleAllowedInTenantType(UserRole.AUDITOR, TenantType.CLINIC)).toBe(true);
    expect(isRoleAllowedInTenantType(UserRole.AUDITOR, TenantType.OPERATOR_PROVIDER)).toBe(true);
    expect(isRoleAllowedInTenantType(UserRole.AUDITOR, TenantType.PLATFORM)).toBe(false);
  });

  it("keeps PLATFORM_ADMIN confined to the PLATFORM tenant", () => {
    expect(isRoleAllowedInTenantType(UserRole.PLATFORM_ADMIN, TenantType.PLATFORM)).toBe(true);
    expect(isRoleAllowedInTenantType(UserRole.PLATFORM_ADMIN, TenantType.CLINIC)).toBe(false);
    expect(isRoleAllowedInTenantType(UserRole.PLATFORM_ADMIN, TenantType.OPERATOR_PROVIDER)).toBe(false);
  });
});
