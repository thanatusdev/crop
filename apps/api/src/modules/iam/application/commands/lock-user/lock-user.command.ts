export class LockUserCommand {
  constructor(
    public readonly targetUserId: string,
    public readonly actingAdminId: string,
    public readonly actingAdminTenantId: string
  ) {}
}
