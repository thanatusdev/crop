export class EnterMaintenanceCommand {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string,
    public readonly actingUserId: string
  ) {}
}
