import { Inject, Logger } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { NotFoundError, TooManyRequestsError, UnauthorizedError } from "../../../../../shared/domain/errors.js";
import { RATE_LIMITER, type RateLimiterPort } from "../../ports/rate-limiter.port.js";
import { TOKEN_REVOCATION, type TokenRevocationPort } from "../../ports/token-revocation.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { ValidatePasswordResetTokenQuery, type ValidatePasswordResetTokenResult } from "./validate-password-reset-token.query.js";

const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

/**
 * Backs `GET /auth/password-reset/validate` -- required, not convenience: only the server
 * knows whether this token was already redeemed (the Redis `pwreset` denylist), so without
 * this a spent link would render a fully working form that only fails on submit. Not an
 * email-enumeration path -- it requires a validly-signed token, which can't be forged, and
 * reveals nothing to anyone who doesn't already have the account owner's own inbox link.
 *
 * Read-only: unlike ResetPasswordHandler, this never denies the `jti` -- calling this
 * endpoint (e.g. the reset screen re-validating on a re-render) must never itself burn the
 * token's single use.
 */
@QueryHandler(ValidatePasswordResetTokenQuery)
export class ValidatePasswordResetTokenHandler
  implements IQueryHandler<ValidatePasswordResetTokenQuery, ValidatePasswordResetTokenResult>
{
  private readonly logger = new Logger(ValidatePasswordResetTokenHandler.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiterPort,
    @Inject(TOKEN_REVOCATION) private readonly revocation: TokenRevocationPort
  ) {}

  async execute(query: ValidatePasswordResetTokenQuery): Promise<ValidatePasswordResetTokenResult> {
    const claims = this.tokens.verifyPasswordReset(query.token);

    // Same reasoning as ResetPasswordHandler's own limiter -- guards against someone
    // brute-forcing a slightly-mangled/guessed token. Shares the confirm endpoint's key
    // scheme deliberately: a validate call and a confirm call against the same token
    // subject should draw from the same budget, not double it.
    const rateLimitKey = `ratelimit:pwreset-confirm:${claims.sub}`;
    const { allowed } = await this.rateLimiter.checkAndIncrement(rateLimitKey, MAX_ATTEMPTS, WINDOW_SECONDS);
    if (!allowed) {
      this.logger.warn(`Rate limit exceeded for password reset validation against user ${claims.sub}`);
      throw new TooManyRequestsError("Too many attempts. Try again later.");
    }

    if (await this.revocation.isRevoked(claims.jti, "password_reset")) {
      throw new UnauthorizedError("This password reset link has already been used");
    }

    const user = await this.users.findById(claims.sub);
    if (!user) throw new NotFoundError("User", claims.sub);

    return {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      professionalRegistration: user.professionalRegistration,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
  }
}
