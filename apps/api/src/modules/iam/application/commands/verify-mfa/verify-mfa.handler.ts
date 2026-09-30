import { Inject, Logger } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { ConfigService } from "@nestjs/config";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError, TooManyRequestsError, UnauthorizedError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { MFA_SERVICE, type MfaServicePort } from "../../ports/mfa-service.port.js";
import { RATE_LIMITER, type RateLimiterPort } from "../../ports/rate-limiter.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { VerifyMfaCommand, type VerifyMfaResult } from "./verify-mfa.command.js";

const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 5 * 60;

@CommandHandler(VerifyMfaCommand)
export class VerifyMfaHandler implements ICommandHandler<VerifyMfaCommand, VerifyMfaResult> {
  private readonly logger = new Logger(VerifyMfaHandler.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(MFA_SERVICE) private readonly mfa: MfaServicePort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiterPort,
    private readonly config: ConfigService,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: VerifyMfaCommand): Promise<VerifyMfaResult> {
    const { sub: userId, clientOs } = this.tokens.verifyMfaChallenge(command.mfaToken);

    // A TOTP code is only 6 digits (10^6 possibilities) and PiKVM-style implementations
    // (this one included, see OtpauthMfaService) tolerate a ±1 time-step window for clock
    // drift -- without a limit here, an attacker who already has a valid password could
    // brute-force the second factor directly. Keyed by userId (known as soon as the
    // challenge token is decoded, before touching the database), which is a tighter target
    // than an IP an attacker could rotate.
    const rateLimitKey = `ratelimit:mfa:${userId}`;
    const { allowed } = await this.rateLimiter.checkAndIncrement(rateLimitKey, MAX_ATTEMPTS, WINDOW_SECONDS);
    if (!allowed) {
      this.logger.warn(`Rate limit exceeded for MFA verification attempts by user ${userId}`);
      throw new TooManyRequestsError("Too many MFA attempts. Try again later.");
    }

    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError("User", userId);

    // An admin can lock an account in between LoginHandler issuing the mfaToken and this
    // step completing it -- re-checked here, not just in LoginHandler, so that window can't
    // be used to finish logging in on a since-locked account.
    if (user.isLocked()) {
      throw new ForbiddenError("This account has been locked. Contact your administrator.");
    }

    if (!user.mfaSecret || !this.mfa.verifyCode(user.mfaSecret, command.code)) {
      await this.audit(user.tenantId, user.id, AuditAction.MFA_FAILURE, {});
      throw new UnauthorizedError("Invalid MFA code");
    }

    await this.users.recordLogin(user.id);
    // This, not the password check in LoginHandler, is the record of a completed login: an
    // attacker with only the password never reaches this line without the TOTP device too.
    await this.audit(user.tenantId, user.id, AuditAction.LOGIN_SUCCESS, {});

    // Both factors just passed -- the ONLY point where that's true and a session hasn't
    // been minted yet. Checking earlier (e.g. in LoginHandler, right after the password) is
    // wrong: it would tell someone holding only a stolen password that it was correct,
    // before they've proven they also hold the TOTP device. See User.passwordChangeReason
    // for which of the two reasons wins when both would apply.
    const maxAgeDays = this.config.get<number>("PASSWORD_MAX_AGE_DAYS", 90);
    const reason = user.passwordChangeReason(maxAgeDays);
    if (reason) {
      return {
        status: "password_change_required",
        changeToken: this.tokens.signPasswordChange(user.id, clientOs),
        reason,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        professionalRegistration: user.professionalRegistration,
      };
    }

    const accessToken = this.tokens.signAccessToken({
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      clientOs,
      // A fresh login always starts in the account's own tenant, so these are equal here. They
      // diverge only after an active-clinic switch -- see AccessTokenClaims.homeTenantId.
      homeTenantId: user.tenantId,
    });
    const refreshToken = this.tokens.signRefreshToken({ sub: user.id, tenantId: user.tenantId, clientOs });

    return { status: "ok", accessToken, refreshToken };
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
