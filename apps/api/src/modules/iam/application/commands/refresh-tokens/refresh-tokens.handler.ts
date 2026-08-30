import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { NotFoundError, UnauthorizedError } from "../../../../../shared/domain/errors.js";
import { TOKEN_REVOCATION, type TokenRevocationPort } from "../../ports/token-revocation.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { RefreshTokensCommand, type RefreshTokensResult } from "./refresh-tokens.command.js";

@CommandHandler(RefreshTokensCommand)
export class RefreshTokensHandler implements ICommandHandler<RefreshTokensCommand, RefreshTokensResult> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(TOKEN_REVOCATION) private readonly revocation: TokenRevocationPort
  ) {}

  async execute(command: RefreshTokensCommand): Promise<RefreshTokensResult> {
    const claims = this.tokens.verifyRefreshToken(command.refreshToken);

    if (await this.revocation.isRevoked(claims.jti)) {
      throw new UnauthorizedError("Refresh token has been revoked");
    }

    // Re-read the user rather than trusting the token's role claim: a role change or
    // deactivation must take effect immediately, not after the old access token expires.
    const user = await this.users.findById(claims.sub);
    if (!user) throw new NotFoundError("User", claims.sub);

    const accessToken = this.tokens.signAccessToken({
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      clientOs: claims.clientOs,
    });
    const refreshToken = this.tokens.signRefreshToken({
      sub: user.id,
      tenantId: user.tenantId,
      clientOs: claims.clientOs,
    });

    // Rotation: the refresh token just used is immediately retired, not left valid until its
    // own expiry. A leaked-and-reused old refresh token becomes a revoked-token error instead
    // of silently working -- standard practice for refresh tokens, and cheap here since the
    // revocation store already exists for logout.
    const remainingSeconds = claims.exp - Math.floor(Date.now() / 1000);
    await this.revocation.revoke(claims.jti, remainingSeconds);

    return { accessToken, refreshToken };
  }
}
