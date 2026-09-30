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
 * what it uses to size that revocation record's own TTL. `iat` is what
 * `RefreshTokensHandler` compares against `User.sessionsRevokedAt` -- a refresh token issued
 * before a password reset must not survive it, even though it isn't individually denylisted
 * by `jti`. */
export interface VerifiedRefreshTokenClaims extends RefreshTokenClaims {
  jti: string;
  iat: number;
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

export interface PasswordResetClaims {
  sub: string;
  purpose: "password_reset";
}

/** Purpose claim for the account-activation link `SendInvitationHandler` emails (the
 * "Enviar Convite Seguro" flow) -- see `signInvitation`'s own docstring. */
export interface InvitationClaims {
  sub: string;
  purpose: "account_invitation";
}

export interface PasswordChangeClaims {
  sub: string;
  purpose: "password_change";
  // Carried through from VerifyMfaHandler's own MfaChallengeClaims (see LoginHandler,
  // which is where clientOs is first detected) so ChangePasswordHandler can mint a real
  // access token at the end without asking the browser to report its platform a second
  // time -- the user already told the server once, at login.
  clientOs: TargetOs;
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
  /** `jti`-bearing, unlike the MFA tokens: this one round-trips through an inbox and must be
   * denylistable after a single use (see TokenRevocationPort's `"password_reset"` kind). The
   * signing side never needs the `jti` back -- only `verifyPasswordReset`, on redemption,
   * does. */
  signPasswordReset(userId: string): string;
  verifyPasswordReset(token: string): PasswordResetClaims & { jti: string; exp: number };
  /** Single-use (jti-bearing, same reasoning as `signPasswordReset`) and long-lived by this
   * app's standards (`INVITE_TTL_SECONDS`, default 24h, matching the "Enviar Convite
   * Seguro" flow's own promise) -- an invitation link sits in an inbox far longer than a
   * password-reset link is expected to, and `SendInvitationHandler`'s resend action mints
   * a fresh one rather than trying to extend the old one's life. */
  signInvitation(userId: string): string;
  verifyInvitation(token: string): InvitationClaims & { jti: string; exp: number };
  /** Issued by VerifyMfaHandler instead of a session, when
   * `User.passwordChangeReason` is non-null. Short-lived (`PASSWORD_CHANGE_TTL_SECONDS`,
   * default 10 min) and `jti`-bearing for the same single-use reasoning as the reset token
   * -- unlike a password-reset link, this one never leaves the browser (see
   * ChangePasswordHandler/the frontend's own comment on why it travels via router state,
   * never a query param or localStorage), but it's still a bearer credential and still only
   * good for one redemption. */
  signPasswordChange(userId: string, clientOs: TargetOs): string;
  verifyPasswordChange(token: string): PasswordChangeClaims & { jti: string; exp: number };
}
