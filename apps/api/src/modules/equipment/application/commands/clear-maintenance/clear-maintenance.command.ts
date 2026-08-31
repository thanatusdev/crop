export class ClearMaintenanceCommand {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string,
    public readonly actingUserId: string
  ) {}
}
