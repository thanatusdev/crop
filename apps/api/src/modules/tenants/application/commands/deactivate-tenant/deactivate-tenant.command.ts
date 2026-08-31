export class DeactivateTenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingAdminId: string
  ) {}
}
