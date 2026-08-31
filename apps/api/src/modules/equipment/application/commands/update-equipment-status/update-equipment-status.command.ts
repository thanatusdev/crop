import type { EquipmentStatus } from "@crop/shared";

export class UpdateEquipmentStatusCommand {
  constructor(
    public readonly equipmentId: string,
    public readonly status: EquipmentStatus,
    // Null for PiKvmHealthPoller's own automatic ONLINE/OFFLINE/DEGRADED transitions (no
    // human acting) -- set for the one other caller, manual maintenance mode
    // (EnterMaintenanceHandler/ClearMaintenanceHandler), so that audit trail correctly
    // attributes it to the admin who did it instead of looking system-triggered.
    public readonly actingUserId: string | null = null
  ) {}
}
