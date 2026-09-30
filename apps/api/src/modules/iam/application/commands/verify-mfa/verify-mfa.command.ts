import type { UserRole } from "@crop/shared";

export class VerifyMfaCommand {
  constructor(
    public readonly mfaToken: string,
    public readonly code: string
  ) {}
}

/**
 * Shaped to slot directly into `LoginResponse` (@crop/shared) -- the controller returns this
 * as-is rather than wrapping it, so there is exactly one place (`packages/shared/src/contracts/
 * auth.ts`) that defines what either branch looks like.
 */
export type VerifyMfaResult =
  | { status: "ok"; accessToken: string; refreshToken: string }
  | {
      status: "password_change_required";
      changeToken: string;
      reason: "must_change" | "expired";
      email: string;
      role: UserRole;
      firstName: string | null;
      lastName: string | null;
      professionalRegistration: string | null;
    };
