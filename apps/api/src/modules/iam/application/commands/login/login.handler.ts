import { Inject, Logger } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { PASSWORD_HASHER, type PasswordHasherPort } from "../../ports/password-hasher.port.js";
import { MFA_SERVICE, type MfaServicePort } from "../../ports/mfa-service.port.js";
import { RATE_LIMITER, type RateLimiterPort } from "../../ports/rate-limiter.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { LoginCommand, type LoginResult } from "./login.command.js";

const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

/**
 * Verifies the password only. MFA is a hard requirement (docs/architecture.md), so this
 * handler deliberately never returns an access/refresh token itself -- see VerifyMfaHandler,
 * the only place tokens are actually minted after a full login.
 */
@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand, LoginResult> {
  private readonly logger = new Logger(LoginHandler.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(MFA_SERVICE) private readonly mfa: MfaServicePort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiterPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: LoginCommand): Promise<LoginResult> {
    // Keyed by the target email, not the caller's IP: the threat this defends against is
    // credential stuffing / brute force against a specific known clinical account, which an
    // attacker can trivially distribute across IPs but not across the one email they're
    // targeting. IP-based limiting is a reasonable defense-in-depth addition later, not a
    // replacement for this. Rate-limit hits are logged, not audited: there is no tenantId to
    // attribute an audit row to for an email that might not even exist (see the identical
    // reasoning below for LOGIN_FAILURE on an unknown email).
    const rateLimitKey = `ratelimit:login:${command.email.toLowerCase()}`;
    const { allowed } = await this.rateLimiter.checkAndIncrement(rateLimitKey, MAX_ATTEMPTS, WINDOW_SECONDS);
    if (!allowed) {
      this.logger.warn(`Rate limit exceeded for login attempts against ${command.email}`);
      throw new TooManyRequestsError("Too many login attempts. Try again later.");
    }

    const user = await this.users.findByEmail(command.email);
    // Same error for "no such user" and "wrong password": distinguishing them lets an
    // attacker enumerate valid emails. Only auditable when a user actually exists --
    // an unknown email has no tenant to attribute the record to, by design (see
    // docs/architecture.md: every audit row is tenant-scoped).
    const invalidCredentials = () => new UnauthorizedError("Invalid credentials");

    if (!user) throw invalidCredentials();

    // Checked before the password: a locked account should be told plainly, not sent down
    // the "invalid credentials" path where a legitimate but locked-out user would keep
    // trying (and confusingly, keep burning their own rate-limit budget) assuming they'd
    // just mistyped it. Unlike a nonexistent email, this does confirm the account exists --
    // an accepted tradeoff on an internal clinical platform with no self-service signup for
    // an attacker to correlate this against, not a public consumer app.
    if (user.isLocked()) {
      await this.audit(user.tenantId, user.id, AuditAction.LOGIN_FAILURE, { reason: "account_locked" });
      throw new ForbiddenError("This account has been locked. Contact your administrator.");
    }

    const passwordOk = await this.hasher.verify(user.passwordHash, command.password);
    if (!passwordOk) {
      await this.audit(user.tenantId, user.id, AuditAction.LOGIN_FAILURE, { reason: "invalid_password" });
      throw invalidCredentials();
    }

    if (!user.isMfaEnrolled()) {
      const secret = user.mfaSecret;
      if (!secret) throw invalidCredentials(); // should be unreachable; account was never provisioned correctly
      return {
        status: "mfa_enrollment_required",
        enrollmentToken: this.tokens.signMfaEnrollment(user.id),
        provisioningUri: this.mfa.provisioningUriFor(secret, user.email),
      };
    }

    await this.audit(user.tenantId, user.id, AuditAction.MFA_CHALLENGE_SENT, {});
    return { status: "mfa_required", mfaToken: this.tokens.signMfaChallenge(user.id, command.clientOs) };
  }

  private async audit(tenantId: string, userId: string, action: AuditAction, details: unknown): Promise<void> {
    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId,
        userId,
        sessionId: null,
        action,
        resourceType: "User",
        resourceId: userId,
        details,
      })
    );
  }
}
