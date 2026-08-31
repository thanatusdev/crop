export class ListQueueByEquipmentQuery {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string
  ) {}
}
