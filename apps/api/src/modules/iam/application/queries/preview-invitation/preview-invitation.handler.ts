import { Inject, Logger } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { NotFoundError, TooManyRequestsError, UnauthorizedError } from "../../../../../shared/domain/errors.js";
import { RATE_LIMITER, type RateLimiterPort } from "../../ports/rate-limiter.port.js";
import { TOKEN_REVOCATION, type TokenRevocationPort } from "../../ports/token-revocation.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { PreviewInvitationQuery, type PreviewInvitationResult } from "./preview-invitation.query.js";

const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

/**
 * Backs `GET /auth/invitation` -- same reasoning as `ValidatePasswordResetTokenHandler`:
 * only the server knows whether this token was already redeemed, so without this a spent
 * link would render a working activation form that only fails on submit. Read-only: never
 * denies the `jti`.
 */
@QueryHandler(PreviewInvitationQuery)
export class PreviewInvitationHandler implements IQueryHandler<PreviewInvitationQuery, PreviewInvitationResult> {
  private readonly logger = new Logger(PreviewInvitationHandler.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiterPort,
    @Inject(TOKEN_REVOCATION) private readonly revocation: TokenRevocationPort
  ) {}

  async execute(query: PreviewInvitationQuery): Promise<PreviewInvitationResult> {
    const claims = this.tokens.verifyInvitation(query.token);

    const rateLimitKey = `ratelimit:invite-confirm:${claims.sub}`;
    const { allowed } = await this.rateLimiter.checkAndIncrement(rateLimitKey, MAX_ATTEMPTS, WINDOW_SECONDS);
    if (!allowed) {
      this.logger.warn(`Rate limit exceeded for invitation preview against user ${claims.sub}`);
      throw new TooManyRequestsError("Too many attempts. Try again later.");
    }

    if (await this.revocation.isRevoked(claims.jti, "account_invitation")) {
      throw new UnauthorizedError("This invitation link has already been used");
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
