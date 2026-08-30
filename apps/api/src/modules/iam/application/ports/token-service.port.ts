import type { AccessTokenClaims, TargetOs } from "@crop/shared";

export const TOKEN_SERVICE = Symbol("TOKEN_SERVICE");

export interface RefreshTokenClaims {
  sub: string;
  tenantId: string;
  clientOs: TargetOs;
}

/** What you get back after verifying a refresh token: the claims it was signed with, plus
 * the standard JWT fields `signRefreshToken` needs no caller involvement to populate --
 * `jti` (a random id, generated internally) is what `LogoutCommand` revokes, and `exp` is
 * what it uses to size that revocation record's own TTL. See RedisTokenRevocationService. */
export interface VerifiedRefreshTokenClaims extends RefreshTokenClaims {
  jti: string;
  exp: number;
}

export interface MfaChallengeClaims {
  sub: string;
  purpose: "mfa_challenge";
  clientOs: TargetOs;
}

export interface MfaEnrollmentClaims {
  sub: string;
  purpose: "mfa_enrollment";
}

export interface TokenServicePort {
  signAccessToken(claims: AccessTokenClaims): string;
  verifyAccessToken(token: string): AccessTokenClaims;
  signRefreshToken(claims: RefreshTokenClaims): string;
  verifyRefreshToken(token: string): VerifiedRefreshTokenClaims;
  signMfaChallenge(userId: string, clientOs: TargetOs): string;
  verifyMfaChallenge(token: string): MfaChallengeClaims;
  signMfaEnrollment(userId: string): string;
  verifyMfaEnrollment(token: string): MfaEnrollmentClaims;
}
