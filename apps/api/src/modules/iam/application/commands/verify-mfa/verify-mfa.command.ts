export class VerifyMfaCommand {
  constructor(
    public readonly mfaToken: string,
    public readonly code: string
  ) {}
}

export interface VerifyMfaResult {
  accessToken: string;
  refreshToken: string;
}
