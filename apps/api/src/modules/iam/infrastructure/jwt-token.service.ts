import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import type { AccessTokenClaims, TargetOs } from "@crop/shared";
import { UnauthorizedError } from "../../../shared/domain/errors.js";
import type {
  MfaChallengeClaims,
  MfaEnrollmentClaims,
  RefreshTokenClaims,
  TokenServicePort,
  VerifiedRefreshTokenClaims,
} from "../application/ports/token-service.port.js";

const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;
const MFA_ENROLLMENT_TTL_SECONDS = 10 * 60;

/**
 * A single JwtService instance, but every purpose (access, refresh, MFA challenge, MFA
 * enrollment) is signed with its own secret and carries its own `purpose` claim. This means
 * a stolen MFA-challenge token cannot be replayed as an access token even if someone
 * mixed up which verify method to call -- the secret alone would already reject it.
 */
@Injectable()
export class JwtTokenService implements TokenServicePort {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService
  ) {
    this.accessSecret = config.getOrThrow<string>("JWT_ACCESS_SECRET");
    this.refreshSecret = config.getOrThrow<string>("JWT_REFRESH_SECRET");
    this.accessTtlSeconds = config.get<number>("JWT_ACCESS_TTL_SECONDS", 900);
    this.refreshTtlSeconds = config.get<number>("JWT_REFRESH_TTL_SECONDS", 604800);
  }

  signAccessToken(claims: AccessTokenClaims): string {
    return this.jwt.sign({ ...claims }, { secret: this.accessSecret, expiresIn: this.accessTtlSeconds });
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    return this.verify(token, this.accessSecret);
  }

  signRefreshToken(claims: RefreshTokenClaims): string {
    // `jwtid` is `jsonwebtoken`'s standard option for a `jti` claim -- generated here, never
    // supplied by a caller, since it exists purely so a specific issued token can later be
    // revoked (see LogoutHandler / TokenRevocationPort), not as something callers reason about.
    return this.jwt.sign({ ...claims }, { secret: this.refreshSecret, expiresIn: this.refreshTtlSeconds, jwtid: randomUUID() });
  }

  verifyRefreshToken(token: string): VerifiedRefreshTokenClaims {
    return this.verify<RefreshTokenClaims & { jti: string; exp: number }>(token, this.refreshSecret);
  }

  signMfaChallenge(userId: string, clientOs: TargetOs): string {
    const claims: MfaChallengeClaims = { sub: userId, purpose: "mfa_challenge", clientOs };
    return this.jwt.sign({ ...claims }, { secret: this.accessSecret, expiresIn: MFA_CHALLENGE_TTL_SECONDS });
  }

  verifyMfaChallenge(token: string): MfaChallengeClaims {
    const claims = this.verify<MfaChallengeClaims>(token, this.accessSecret);
    if (claims.purpose !== "mfa_challenge") throw new UnauthorizedError("Invalid MFA challenge token");
    return claims;
  }

  signMfaEnrollment(userId: string): string {
    const claims: MfaEnrollmentClaims = { sub: userId, purpose: "mfa_enrollment" };
    return this.jwt.sign({ ...claims }, { secret: this.accessSecret, expiresIn: MFA_ENROLLMENT_TTL_SECONDS });
  }

  verifyMfaEnrollment(token: string): MfaEnrollmentClaims {
    const claims = this.verify<MfaEnrollmentClaims>(token, this.accessSecret);
    if (claims.purpose !== "mfa_enrollment") throw new UnauthorizedError("Invalid MFA enrollment token");
    return claims;
  }

  private verify<T extends object>(token: string, secret: string): T {
    try {
      return this.jwt.verify<T>(token, { secret });
    } catch {
      throw new UnauthorizedError("Invalid or expired token");
    }
  }
}
