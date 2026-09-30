import { UserRole } from "@crop/shared";

/**
 * Which roles may be assigned as a unit's "Gestor Técnico Local" (technical manager) --
 * the clinic-side roles with real day-to-day operational authority over a unit:
 * `CLINIC_ADMIN` (runs the clinic), `LOCAL_SUPERVISOR` (runs its floor), `LOCAL_IT`
 * (provisions/maintains its equipment). Deliberately excludes `NURSING` (clinical staff,
 * not operational authority) and every operator-side role (`OPERATOR`/
 * `OPERATIONAL_SUPERVISOR`/`OPERATOR_ADMIN`, whose home tenant is the operator company, not
 * the clinic itself, and `AUDITOR`, whose role is oversight, not operation).
 */
export const TECHNICAL_MANAGER_ELIGIBLE_ROLES: readonly UserRole[] = [
  UserRole.CLINIC_ADMIN,
  UserRole.LOCAL_SUPERVISOR,
  UserRole.LOCAL_IT,
];

export function isEligibleTechnicalManager(user: { role: UserRole }): boolean {
  return TECHNICAL_MANAGER_ELIGIBLE_ROLES.includes(user.role);
}
