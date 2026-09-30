import { Inject, Logger } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { ConfigService } from "@nestjs/config";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError, TooManyRequestsError, UnauthorizedError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { PASSWORD_HASHER, type PasswordHasherPort } from "../../ports/password-hasher.port.js";
import { RATE_LIMITER, type RateLimiterPort } from "../../ports/rate-limiter.port.js";
import { TOKEN_REVOCATION, type TokenRevocationPort } from "../../ports/token-revocation.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import { assertPasswordNotReused, assertPasswordPolicy } from "../../enforce-password-policy.js";
import { ChangePasswordCommand, type ChangePasswordResult } from "./change-password.command.js";

const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

/**
 * Redeems a `password_change_required` response's `changeToken` (see VerifyMfaHandler,
 * the only place that branch is ever returned). No current-password field: the caller
 * already proved both password and TOTP to get this token in the first place, so asking
 * again would be redundant, not safer.
 *
 * Mints real session tokens directly on success, rather than making the caller log in a
 * second time -- both factors were just satisfied a few requests ago, and asking for a
 * third round trip through /auth/login would be friction with no security benefit.
 *
 * Order mirrors ResetPasswordHandler: rate limit, verify the token, single-use, re-check
 * lock/deactivation (an admin could act in the window between the forced-change screen
 * loading and this request landing), policy + reuse, then the write.
 */
@CommandHandler(ChangePasswordCommand)
export class ChangePasswordHandler implements ICommandHandler<ChangePasswordCommand, ChangePasswordResult> {
  private readonly logger = new Logger(ChangePasswordHandler.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiterPort,
    @Inject(TOKEN_REVOCATION) private readonly revocation: TokenRevocationPort,
    private readonly config: ConfigService,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: ChangePasswordCommand): Promise<ChangePasswordResult> {
    const claims = this.tokens.verifyPasswordChange(command.changeToken);

    const rateLimitKey = `ratelimit:pwchange-confirm:${claims.sub}`;
    const { allowed } = await this.rateLimiter.checkAndIncrement(rateLimitKey, MAX_ATTEMPTS, WINDOW_SECONDS);
    if (!allowed) {
      this.logger.warn(`Rate limit exceeded for password change confirmation against user ${claims.sub}`);
      throw new TooManyRequestsError("Too many attempts. Try again later.");
    }

    if (await this.revocation.isRevoked(claims.jti, "password_change")) {
      throw new UnauthorizedError("This session has expired. Please log in again.");
    }

    const user = await this.users.findById(claims.sub);
    if (!user) throw new NotFoundError("User", claims.sub);

    if (user.isLocked()) {
      throw new ForbiddenError("This account has been locked. Contact your administrator.");
    }
    const tenant = await this.tenants.findById(user.tenantId);
    if (tenant?.isDeactivated()) {
      throw new ForbiddenError("This organization's access has been deactivated. Contact your administrator.");
    }

    assertPasswordPolicy(command.newPassword, { email: user.email, firstName: user.firstName, lastName: user.lastName });
    const historyDepth = this.config.get<number>("PASSWORD_HISTORY_DEPTH", 5);
    await assertPasswordNotReused(command.newPassword, user.id, { users: this.users, hasher: this.hasher }, historyDepth);

    const passwordHash = await this.hasher.hash(command.newPassword);
    // mustChangePassword: false -- the user just chose this themselves, whether they were
    // here because of an admin-issued temp password or because the old one simply expired.
    await this.users.setPassword(user.id, passwordHash, { mustChangePassword: false });

    const remainingSeconds = claims.exp - Math.floor(Date.now() / 1000);
    await this.revocation.revoke(claims.jti, remainingSeconds, "password_change");

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: user.tenantId,
        userId: user.id,
        sessionId: null,
        action: AuditAction.PASSWORD_CHANGED,
        resourceType: "User",
        resourceId: user.id,
        details: {},
      })
    );

    // Mints a real session here, not a redirect back to /login -- see class docstring.
    // `setPassword` above already set `sessionsRevokedAt` to "now", but that column is
    // compared against a refresh token's `iat` (RefreshTokensHandler), and this token is
    // signed strictly after that write completes, so it is unaffected by its own revocation.
    const accessToken = this.tokens.signAccessToken({
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      clientOs: claims.clientOs,
      homeTenantId: user.tenantId,
    });
    const refreshToken = this.tokens.signRefreshToken({ sub: user.id, tenantId: user.tenantId, clientOs: claims.clientOs });

    return { accessToken, refreshToken };
  }
}
