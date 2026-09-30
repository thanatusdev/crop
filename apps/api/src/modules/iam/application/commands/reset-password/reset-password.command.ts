export class ResetPasswordCommand {
  constructor(
    public readonly token: string,
    public readonly newPassword: string
  ) {}
}
