import { UserRole } from "@crop/shared";

/**
 * Single source of truth for which sidebar/topbar nav items a role sees -- previously
 * computed three separate times (`DashboardPage`'s own `canView*`/`canManage*` booleans,
 * `App.tsx`'s `RoleRoute allowed` lists, and each controller's own `@Roles`), which is how
 * this app ended up with the same role sets hand-copied in three places. `App.tsx`'s
 * `RoleRoute` lists stay separate on purpose (they're the actual authorization UX gate, and
 * each one's own comment already documents which controller's `@Roles` it mirrors) -- this
 * is specifically for "should the nav item even render," consumed by `ConsoleShell` and
 * `DashboardPage`.
 */
export interface NavPermissions {
  canViewAudit: boolean;
  canManageUsers: boolean;
  canManageEquipment: boolean;
  canManageUnits: boolean;
  canManagePlatform: boolean;
  canManageQueue: boolean;
  canManageAgreements: boolean;
  canViewOperations: boolean;
  canSelectWorkstation: boolean;
}

export function computeNavPermissions(role: UserRole | undefined): NavPermissions {
  return {
    // Mirrors AuditController's @Roles.
    canViewAudit:
      role === UserRole.AUDITOR ||
      role === UserRole.OPERATIONAL_SUPERVISOR ||
      role === UserRole.LOCAL_SUPERVISOR ||
      role === UserRole.CLINIC_ADMIN ||
      role === UserRole.OPERATOR_ADMIN ||
      role === UserRole.PLATFORM_ADMIN,
    // Mirrors UsersController's @Roles. LOCAL_SUPERVISOR is included because it may now
    // create clinic staff -- what it may NOT create (managers, other supervisors) is
    // enforced by ROLE_GRANTS inside RegisterUserHandler, not by whether this nav item
    // renders. AdminUsersPage already builds its role dropdown from ROLE_GRANTS, so a
    // supervisor landing there is offered exactly NURSING and LOCAL_IT.
    canManageUsers:
      role === UserRole.CLINIC_ADMIN ||
      role === UserRole.LOCAL_SUPERVISOR ||
      role === UserRole.OPERATOR_ADMIN ||
      role === UserRole.PLATFORM_ADMIN,
    // Mirrors EquipmentController's POST/@Roles -- LOCAL_IT has equipment permissions but
    // not user-management ones, so this is deliberately its own flag. OPERATOR_ADMIN was
    // removed when equipment/unit provisioning became clinic-only (see roles.ts's role-model
    // inversion and EquipmentController's own comment).
    canManageEquipment:
      role === UserRole.CLINIC_ADMIN ||
      role === UserRole.LOCAL_SUPERVISOR ||
      role === UserRole.LOCAL_IT ||
      role === UserRole.PLATFORM_ADMIN,
    // Mirrors UnitsController's POST/@Roles -- identical set to canManageEquipment today
    // (provisioning a unit is the same kind of clinic-administration action), kept as its
    // own flag rather than an alias since nothing guarantees the two stay identical forever.
    canManageUnits:
      role === UserRole.CLINIC_ADMIN ||
      role === UserRole.LOCAL_SUPERVISOR ||
      role === UserRole.LOCAL_IT ||
      role === UserRole.PLATFORM_ADMIN,
    // Mirrors TenantsController's @Roles -- PLATFORM_ADMIN only, deliberately NOT lumped
    // with canManageUsers: tenant lifecycle is the one thing a CLINIC_ADMIN never gets.
    canManagePlatform: role === UserRole.PLATFORM_ADMIN,
    // Mirrors QueueController's reorder/:id-PATCH/preparation method-level @Roles (see
    // queue.controller.ts) -- deliberately narrower than canManageEquipment/canManageUsers:
    // it's its own flag because no other nav permission's role set matches it (NURSING is
    // here but not in any of the above; LOCAL_IT is in canManageEquipment but not here).
    canManageQueue:
      role === UserRole.NURSING ||
      role === UserRole.LOCAL_SUPERVISOR ||
      role === UserRole.CLINIC_ADMIN ||
      role === UserRole.PLATFORM_ADMIN,
    // Mirrors AgreementsController's @Roles -- the administrator of each side of the contract, plus
    // PLATFORM_ADMIN. Deliberately excludes OPERATOR/OPERATIONAL_SUPERVISOR: running exams and
    // supervising sessions are not the same authority as signing or ending the commercial
    // relationship that makes them possible.
    canManageAgreements:
      role === UserRole.CLINIC_ADMIN ||
      role === UserRole.LOCAL_SUPERVISOR ||
      role === UserRole.OPERATOR_ADMIN ||
      role === UserRole.PLATFORM_ADMIN,
    // DashboardPage's whole surface is remote-session/equipment operation. Two roles are
    // deliberately excluded despite otherwise having real permissions, each for its own
    // screen rather than the generic multi-equipment dashboard: NURSING never starts,
    // watches, or takes over a session (its own screen is "/enfermagem", canManageQueue);
    // OPERATOR has its own real landing page too (`WorkstationPage`, `/posto-de-trabalho`,
    // see role-routes.ts and canSelectWorkstation below) and showing "Painel" alongside it
    // offered a second, non-converging path to the same equipment (Dashboard's own
    // "Iniciar sessão" button lands on the generic `SessionPage`, not the operator's
    // dedicated `ExamPage` cockpit `WorkstationPage` actually confirms into). Everyone else
    // keeps seeing Dashboard exactly as before.
    canViewOperations: role !== UserRole.NURSING && role !== UserRole.OPERATOR,
    // Mirrors this route's own `RoleRoute allowed={[OPERATOR]}` in App.tsx -- the
    // workstation-selection screen (clinic -> unit -> equipment, narrowed to whatever the
    // operator's own company holds an active `OperatorAgreement` for) is OPERATOR's real
    // home route (role-routes.ts) and nobody else's; OPERATOR_ADMIN/OPERATIONAL_SUPERVISOR
    // deliberately stay on the generic Dashboard instead (see that route's own comment).
    canSelectWorkstation: role === UserRole.OPERATOR,
  };
}
