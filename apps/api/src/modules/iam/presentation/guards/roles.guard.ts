import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { UserRole } from "@crop/shared";
import type { AccessTokenClaims } from "@crop/shared";
import { ForbiddenError } from "../../../../shared/domain/errors.js";
import { ROLES_KEY } from "../decorators/roles.decorator.js";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<{ user: AccessTokenClaims }>().user;
    if (!required.includes(user.role)) {
      throw new ForbiddenError(`Requires one of roles: ${required.join(", ")}`);
    }
    return true;
  }
}
