import type { UserDto } from "@crop/shared";
import { User } from "../domain/user.entity.js";

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
    mfaEnrolled: user.isMfaEnrolled(),
    locked: user.isLocked(),
  };
}
