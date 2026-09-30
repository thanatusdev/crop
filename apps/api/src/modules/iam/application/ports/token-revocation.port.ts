export const TOKEN_REVOCATION = Symbol("TOKEN_REVOCATION");

/** Which family a denylisted `jti` belongs to -- kept separate per kind (see
 * RedisTokenRevocationService) so a revoked refresh token and a redeemed password-reset
 * token never share one namespace, even though `jti`s are random UUIDs and would never
 * actually collide. Defaults to `"refresh"` everywhere below for backward compatibility --
 * LogoutHandler/RefreshTokensHandler predate password reset and never pass this argument. */
export type RevocationKind = "refresh" | "password_reset" | "password_change" | "account_invitation";

/**
 * A denylist of revoked token ids (`jti`), not an allowlist of valid ones: JWTs are
 * stateless by design (no DB/Redis lookup needed to validate a token that hasn't been
 * revoked), so this only needs to remember the rare case of an explicit logout or a
 * single-use token already redeemed, not every token ever issued. Each revocation entry is
 * stored with a TTL matching the token's own remaining lifetime -- once the token would have
 * expired anyway, there is nothing left to revoke, so the entry is free to disappear too
 * rather than accumulating forever.
 */
export interface TokenRevocationPort {
  revoke(jti: string, ttlSeconds: number, kind?: RevocationKind): Promise<void>;
  isRevoked(jti: string, kind?: RevocationKind): Promise<boolean>;
}
