export class ChangePasswordCommand {
  constructor(
    public readonly changeToken: string,
    public readonly newPassword: string
  ) {}
}

export interface ChangePasswordResult {
  accessToken: string;
  refreshToken: string;
}
