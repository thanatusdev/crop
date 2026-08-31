export class ReactivateTenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingAdminId: string
  ) {}
}
