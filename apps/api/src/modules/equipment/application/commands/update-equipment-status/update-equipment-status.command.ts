import type { EquipmentStatus } from "@crop/shared";

export class UpdateEquipmentStatusCommand {
  constructor(
    public readonly equipmentId: string,
    public readonly status: EquipmentStatus
  ) {}
}
