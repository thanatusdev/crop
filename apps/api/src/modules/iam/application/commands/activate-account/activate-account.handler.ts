import { Inject, Logger } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError, TooManyRequestsError, UnauthorizedError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { PASSWORD_HASHER, type PasswordHasherPort } from "../../ports/password-hasher.port.js";
import { RATE_LIMITER, type RateLimiterPort } from "../../ports/rate-limiter.port.js";
import { TOKEN_REVOCATION, type TokenRevocationPort } from "../../ports/token-revocation.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import { assertPasswordPolicy } from "../../enforce-password-policy.js";
import { ActivateAccountCommand } from "./activate-account.command.js";

const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

/**
 * The redemption side of `SendInvitationHandler` -- same shape and ordering as
 * `ResetPasswordHandler` (rate limit, verify the token, single-use, lock/deactivation, then
 * the write), but this is the *first* password an account ever gets, not a replacement --
 * there is no reuse check (no history exists yet) and no "sessions revoked" implication
 * (there was never a session to revoke).
 */
@CommandHandler(ActivateAccountCommand)
export class ActivateAccountHandler implements ICommandHandler<ActivateAccountCommand, void> {
  private readonly logger = new Logger(ActivateAccountHandler.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiterPort,
    @Inject(TOKEN_REVOCATION) private readonly revocation: TokenRevocationPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: ActivateAccountCommand): Promise<void> {
    const claims = this.tokens.verifyInvitation(command.token);

    const rateLimitKey = `ratelimit:invite-confirm:${claims.sub}`;
    const { allowed } = await this.rateLimiter.checkAndIncrement(rateLimitKey, MAX_ATTEMPTS, WINDOW_SECONDS);
    if (!allowed) {
      this.logger.warn(`Rate limit exceeded for invitation confirmation against user ${claims.sub}`);
      throw new TooManyRequestsError("Too many attempts. Try again later.");
    }

    if (await this.revocation.isRevoked(claims.jti, "account_invitation")) {
      throw new UnauthorizedError("This invitation link has already been used");
    }

    const user = await this.users.findById(claims.sub);
    if (!user) throw new NotFoundError("User", claims.sub);

    if (user.isActivated()) {
      throw new UnauthorizedError("This invitation link has already been used");
    }

    // An admin could lock the account, or a Platform Admin deactivate its tenant, in the
    // window between the invitation being sent and this link being clicked -- same
    // bounded-window reasoning ResetPasswordHandler documents for its own checks.
    if (user.isLocked()) {
      throw new ForbiddenError("This account has been locked. Contact your administrator.");
    }
    const tenant = await this.tenants.findById(user.tenantId);
    if (tenant?.isDeactivated()) {
      throw new ForbiddenError("This organization's access has been deactivated. Contact your administrator.");
    }

    assertPasswordPolicy(command.newPassword, { email: user.email, firstName: user.firstName, lastName: user.lastName });
    // No reuse check: this is the account's first password, there is no history to reuse
    // against (see UserRepositoryPort.activate's own docstring).

    const passwordHash = await this.hasher.hash(command.newPassword);
    await this.users.activate(user.id, passwordHash);

    const remainingSeconds = claims.exp - Math.floor(Date.now() / 1000);
    await this.revocation.revoke(claims.jti, remainingSeconds, "account_invitation");

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: user.tenantId,
        userId: user.id,
        sessionId: null,
        action: AuditAction.USER_ACTIVATED,
        resourceType: "User",
        resourceId: user.id,
        details: {},
      })
    );
  }
}
