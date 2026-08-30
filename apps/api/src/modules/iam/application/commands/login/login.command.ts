import { TargetOs } from "@crop/shared";

export class LoginCommand {
  constructor(
    public readonly email: string,
    public readonly password: string,
    public readonly clientOs: TargetOs
  ) {}
}

export type LoginResult =
  | { status: "mfa_enrollment_required"; enrollmentToken: string; provisioningUri: string }
  | { status: "mfa_required"; mfaToken: string }
  | { status: "ok"; accessToken: string; refreshToken: string };
