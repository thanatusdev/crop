import type { UserDto } from "@crop/shared";
import { User } from "../domain/user.entity.js";

/** `clinicTenantIds` isn't on the `User` entity itself (it lives in the separate
 * `UserClinicMembership` table) -- callers fetch it themselves (see
 * `UserClinicMembershipRepositoryPort`) and pass it in, falling back to `[user.tenantId]`
 * for the roles that never get a membership row at all (operator-side, platform). */
export function toUserDto(user: User, clinicTenantIds?: readonly string[]): UserDto {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    professionalRegistration: user.professionalRegistration,
    mfaEnrolled: user.isMfaEnrolled(),
    locked: user.isLocked(),
    mustChangePassword: user.mustChangePassword,
    activated: user.isActivated(),
    clinicTenantIds: clinicTenantIds && clinicTenantIds.length > 0 ? [...clinicTenantIds] : [user.tenantId],
  };
}
