import type { MouseMode, TargetOs } from "@crop/shared";

export interface EquipmentChanges {
  name?: string;
  pikvmHost?: string;
  pikvmUser?: string;
  pikvmPassword?: string;
  targetOs?: TargetOs;
  keymap?: string;
  mouseMode?: MouseMode;
  screenWidth?: number;
  screenHeight?: number;
  cameraUrl?: string | null;
}

export class UpdateEquipmentCommand {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly changes: EquipmentChanges
  ) {}
}
