export class SetEquipmentDeactivatedCommand {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string,
    public readonly actingUserId: string,
    /** `true` retires the device from service; `false` returns it. */
    public readonly deactivated: boolean
  ) {}
}
