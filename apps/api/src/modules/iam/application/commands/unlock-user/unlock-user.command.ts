export class UnlockUserCommand {
  constructor(
    public readonly targetUserId: string,
    public readonly actingAdminId: string,
    public readonly actingAdminTenantId: string
  ) {}
}
