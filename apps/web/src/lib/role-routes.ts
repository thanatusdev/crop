import { UserRole } from "@crop/shared";

/**
 * Where each role lands right after MFA verification. Until this file, every role redirected
 * to "/" regardless (LoginPage.tsx hardcoded `navigate("/")`) -- see docs/architecture.md.
 *
 * CLINIC_ADMIN deliberately stays on "/" alongside the operator-side roles: it already has
 * working admin surfaces there (Manage users/equipment, reachable from DashboardPage's
 * topbar), and there is no clinic-specific dashboard yet to send it to instead -- moving it
 * would regress a working page for no replacement.
 *
 * NURSING moved off the "/clinica" stub to "/enfermagem" once that role's own screen (the
 * quick-action patient-preparation feature) existed -- it's no longer one of the "never had
 * a home screen at all" roles the stub's own docstring describes. LOCAL_SUPERVISOR and
 * LOCAL_IT stay on "/clinica": LOCAL_SUPERVISOR can also reach "/enfermagem" via
 * ConsoleShell's nav (see nav-permissions.ts's `canManageQueue`), but its own dedicated
 * landing page -- session supervision -- doesn't exist yet either, so there is still no
 * better default for it than the stub. LOCAL_IT has no queue access at all
 * (QueueController's own @Roles deliberately excludes it) and so has nothing to move to.
 *
 * OPERATOR moved off "/" to "/posto-de-trabalho" (the workstation-selection screen) once
 * that screen existed, for the same reason NURSING moved off "/clinica" to "/enfermagem":
 * it is now a role with a real screen of its own, not one that has to share the generic
 * multi-equipment dashboard. OPERATOR_ADMIN and OPERATIONAL_SUPERVISOR deliberately stay on
 * "/" -- unlike a plain OPERATOR, they are not this workstation screen's audience (see its
 * own `RoleRoute` in App.tsx), and "/" is still their working admin/oversight surface.
 */
const ROLE_HOME_ROUTES: Record<UserRole, string> = {
  [UserRole.PLATFORM_ADMIN]: "/",
  [UserRole.CLINIC_ADMIN]: "/",
  [UserRole.OPERATOR]: "/posto-de-trabalho",
  [UserRole.OPERATIONAL_SUPERVISOR]: "/",
  [UserRole.OPERATOR_ADMIN]: "/",
  [UserRole.AUDITOR]: "/",
  [UserRole.LOCAL_SUPERVISOR]: "/clinica",
  [UserRole.NURSING]: "/enfermagem",
  [UserRole.LOCAL_IT]: "/clinica",
};

/** The route to send a just-authenticated user to, based on their role. */
export function homeRouteForRole(role: UserRole): string {
  return ROLE_HOME_ROUTES[role];
}
