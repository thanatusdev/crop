import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { CommandBus } from "@nestjs/cqrs";
import type { Request } from "express";
import { AuditAction, type UserRole } from "@crop/shared";
import type { AccessTokenClaims } from "@crop/shared";
import { ForbiddenError } from "../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { ROLES_KEY } from "../decorators/roles.decorator.js";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly commandBus: CommandBus
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user: AccessTokenClaims }>();
    const user = request.user;
    if (!required.includes(user.role)) {
      // Denied-access attempts are security-relevant on their own, independent of whether
      // the underlying resource even exists -- an OPERATOR repeatedly probing admin-only
      // routes is worth a compliance officer being able to find, not just a 403 the client
      // silently swallows. Awaited, not fire-and-forget: this is the same "critical event,
      // written synchronously" tier as LOGIN_FAILURE, not the buffered HID-input tier.
      await this.commandBus.execute(
        new RecordAuditEventCommand({
          tenantId: user.tenantId,
          userId: user.sub,
          sessionId: null,
          action: AuditAction.PERMISSION_DENIED,
          resourceType: "Route",
          resourceId: null,
          details: { method: request.method, path: request.path, requiredRoles: required, actualRole: user.role },
        })
      );
      throw new ForbiddenError(`Requires one of roles: ${required.join(", ")}`);
    }
    return true;
  }
}

