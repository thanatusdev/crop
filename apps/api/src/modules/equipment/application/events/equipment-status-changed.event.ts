import type { EquipmentStatus } from "@crop/shared";

/** Same reasoning as QueueUpdatedEvent -- see its own docstring. */
export class EquipmentStatusChangedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly equipmentId: string,
    public readonly status: EquipmentStatus
  ) {}
}
