export class GetEquipmentQuery {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string
  ) {}
}
