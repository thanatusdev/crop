export class ActivateAccountCommand {
  constructor(
    public readonly token: string,
    public readonly newPassword: string
  ) {}
}
