import * as OTPAuth from "otpauth";

export interface PiKvmCredentials {
  /** e.g. "https://10.0.1.50" -- always include the scheme, PiKVM's default is self-signed HTTPS. */
  baseUrl: string;
  user: string;
  password: string;
  /** Base32 TOTP secret, only present if the PiKVM device itself has 2FA enabled. */
  totpSecret?: string;
}

/**
 * PiKVM concatenates the TOTP code directly onto the password with no separator
 * (password "foobar" + code "123456" => "foobar123456"). Requests made within the last
 * second of the current 30s TOTP window are prone to landing just as the code rotates,
 * which the device answers with 403. `remainingWindowMs` lets a caller defer such requests
 * by a beat rather than retry after an avoidable failure.
 */
export function buildPassword(credentials: PiKvmCredentials): string {
  if (!credentials.totpSecret) {
    return credentials.password;
  }
  const totp = new OTPAuth.TOTP({ secret: credentials.totpSecret });
  return credentials.password + totp.generate();
}

export function remainingTotpWindowMs(totpSecret: string, period = 30): number {
  const now = Date.now();
  const windowMs = period * 1000;
  return windowMs - (now % windowMs);
}

export function buildAuthHeaders(credentials: PiKvmCredentials): Record<string, string> {
  return {
    "X-KVMD-User": credentials.user,
    "X-KVMD-Passwd": buildPassword(credentials),
  };
}
