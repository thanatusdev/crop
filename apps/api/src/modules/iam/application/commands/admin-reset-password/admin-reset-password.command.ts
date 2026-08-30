export class AdminResetPasswordCommand {
  constructor(
    public readonly targetUserId: string,
    public readonly newPassword: string,
    public readonly actingAdminId: string,
    public readonly actingAdminTenantId: string
  ) {}
}
