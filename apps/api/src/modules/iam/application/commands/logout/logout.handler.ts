import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { TOKEN_REVOCATION, type TokenRevocationPort } from "../../ports/token-revocation.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { LogoutCommand } from "./logout.command.js";

/**
 * The real implementation behind `AuditAction.LOGOUT` -- previously defined in the enum but
 * never dispatched anywhere, since there was no revocation mechanism for logout to actually
 * do anything with a stateless JWT. An already-invalid or expired refresh token makes this
 * throw (via `verifyRefreshToken`), which is fine: the frontend clears its local tokens
 * regardless of this call's outcome (see auth-context.tsx), so there's nothing to gain from
 * swallowing that error here just to always return success.
 */
@CommandHandler(LogoutCommand)
export class LogoutHandler implements ICommandHandler<LogoutCommand, void> {
  constructor(
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(TOKEN_REVOCATION) private readonly revocation: TokenRevocationPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: LogoutCommand): Promise<void> {
    const claims = this.tokens.verifyRefreshToken(command.refreshToken);

    const remainingSeconds = claims.exp - Math.floor(Date.now() / 1000);
    await this.revocation.revoke(claims.jti, remainingSeconds);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: claims.tenantId,
        userId: claims.sub,
        sessionId: null,
        action: AuditAction.LOGOUT,
        resourceType: "User",
        resourceId: claims.sub,
        details: {},
      })
    );
  }
}
