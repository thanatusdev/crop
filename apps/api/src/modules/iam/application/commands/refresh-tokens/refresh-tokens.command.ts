export class RefreshTokensCommand {
  constructor(public readonly refreshToken: string) {}
}

export interface RefreshTokensResult {
  accessToken: string;
  refreshToken: string;
}
