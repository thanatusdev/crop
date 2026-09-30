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
import { ResetPasswordCommand } from "./reset-password.command.js";

const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

/**
 * The redemption side of RequestPasswordResetHandler -- see that class's docstring for why
 * self-service reset exists at all now. Unlike the request side, this does NOT hide whether
 * the token is valid: by the time someone has a token in hand (from their own inbox, or a
 * stolen/guessed one), "is this token good" is no longer an email-enumeration question, and
 * a clear error here (expired, already used, tampered) is genuinely useful to a real user
 * whose link went stale.
 *
 * Order mirrors LoginHandler/ExecuteTakeoverHandler's own documented ordering: rate limit,
 * then verify the token itself, then single-use, then lock/deactivation (an account can be
 * locked *after* the email went out, and that must still win), then the actual write.
 */
@CommandHandler(ResetPasswordCommand)
export class ResetPasswordHandler implements ICommandHandler<ResetPasswordCommand, void> {
  private readonly logger = new Logger(ResetPasswordHandler.name);

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

  async execute(command: ResetPasswordCommand): Promise<void> {
    const claims = this.tokens.verifyPasswordReset(command.token);

    // Keyed by the token's own subject, not the caller's IP -- guards against someone
    // brute-forcing a slightly-mangled/guessed token, the equivalent threat
    // VerifyMfaHandler's own limiter defends against for TOTP codes.
    const rateLimitKey = `ratelimit:pwreset-confirm:${claims.sub}`;
    const { allowed } = await this.rateLimiter.checkAndIncrement(rateLimitKey, MAX_ATTEMPTS, WINDOW_SECONDS);
    if (!allowed) {
      this.logger.warn(`Rate limit exceeded for password reset confirmation against user ${claims.sub}`);
      throw new TooManyRequestsError("Too many attempts. Try again later.");
    }

    if (await this.revocation.isRevoked(claims.jti, "password_reset")) {
      throw new UnauthorizedError("This password reset link has already been used");
    }

    const user = await this.users.findById(claims.sub);
    if (!user) throw new NotFoundError("User", claims.sub);

    // Re-checked here, not just at request time: an admin could have locked this account,
    // or deactivated its tenant, in the window between the email being sent and this link
    // being clicked -- same bounded-window reasoning RefreshTokensHandler documents for its
    // own lock/deactivation checks.
    if (user.isLocked()) {
      throw new ForbiddenError("This account has been locked. Contact your administrator.");
    }
    const tenant = await this.tenants.findById(user.tenantId);
    if (tenant?.isDeactivated()) {
      throw new ForbiddenError("This organization's access has been deactivated. Contact your administrator.");
    }

    // Both checks every password-setting path enforces -- see enforce-password-policy.ts.
    // Both run before hashing the new password below: there's no reason to spend an
    // argon2id hash on a request about to be rejected anyway.
    assertPasswordPolicy(command.newPassword, { email: user.email, firstName: user.firstName, lastName: user.lastName });
    const historyDepth = this.config.get<number>("PASSWORD_HISTORY_DEPTH", 5);
    await assertPasswordNotReused(command.newPassword, user.id, { users: this.users, hasher: this.hasher }, historyDepth);

    const passwordHash = await this.hasher.hash(command.newPassword);
    // One write (see UserRepositoryPort.setPassword's own docstring) -- the password change,
    // its history entry, and the session revocation it implies happen atomically, not as
    // separate updates that could observably land apart. `mustChangePassword: false`: the
    // user just chose this themselves, so nothing forces them to change it again next login.
    await this.users.setPassword(user.id, passwordHash, { mustChangePassword: false });

    // Denied only after the write succeeds: a failure between verifying the token and
    // committing the password change should leave the token still redeemable, not burn it
    // for nothing.
    const remainingSeconds = claims.exp - Math.floor(Date.now() / 1000);
    await this.revocation.revoke(claims.jti, remainingSeconds, "password_reset");

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: user.tenantId,
        userId: user.id,
        sessionId: null,
        action: AuditAction.PASSWORD_RESET_COMPLETED,
        resourceType: "User",
        resourceId: user.id,
        details: {},
      })
    );
  }
}
