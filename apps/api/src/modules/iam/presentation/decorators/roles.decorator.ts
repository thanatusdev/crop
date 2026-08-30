import { SetMetadata } from "@nestjs/common";
import type { UserRole } from "@crop/shared";

export const ROLES_KEY = "roles";

/** Marks a controller/handler as requiring one of the given roles. Enforced by RolesGuard. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
