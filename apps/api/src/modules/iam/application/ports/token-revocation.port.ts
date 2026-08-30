export const TOKEN_REVOCATION = Symbol("TOKEN_REVOCATION");

/**
 * A denylist of revoked refresh-token ids (`jti`), not an allowlist of valid ones: JWTs are
 * stateless by design (no DB/Redis lookup needed to validate a token that hasn't been
 * revoked), so this only needs to remember the rare case of an explicit logout, not every
 * token ever issued. Each revocation entry is stored with a TTL matching the token's own
 * remaining lifetime -- once the token would have expired anyway, there is nothing left to
 * revoke, so the entry is free to disappear too rather than accumulating forever.
 */
export interface TokenRevocationPort {
  revoke(jti: string, ttlSeconds: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}
