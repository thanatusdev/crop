import { Injectable } from "@nestjs/common";
import * as OTPAuth from "otpauth";
import type { MfaSecretAndUri, MfaServicePort } from "../application/ports/mfa-service.port.js";

// Cosmetic only: `verifyCode` builds its TOTP from the stored secret alone (see below), never
// from this string, so changing it doesn't invalidate any existing enrollment. It does mean
// a user enrolled before this rename keeps seeing "CROP" in their authenticator app, since
// the issuer is baked into the entry at scan time -- only *new* enrollments see "RadLink".
const ISSUER = "RadLink";

@Injectable()
export class OtpauthMfaService implements MfaServicePort {
  generateSecret(accountLabel: string): MfaSecretAndUri {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    return { secret, provisioningUri: this.provisioningUriFor(secret, accountLabel) };
  }

  provisioningUriFor(secret: string, accountLabel: string): string {
    const totp = new OTPAuth.TOTP({ issuer: ISSUER, label: accountLabel, secret });
    return totp.toString();
  }

  verifyCode(secret: string, code: string): boolean {
    const totp = new OTPAuth.TOTP({ secret });
    // window: 1 tolerates one 30s step of clock drift between server and authenticator app,
    // which is the difference between "works" and "fails intermittently on a real phone".
    return totp.validate({ token: code, window: 1 }) !== null;
  }
}
