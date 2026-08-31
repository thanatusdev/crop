import type { EquipmentDto } from "@crop/shared";
import { Equipment } from "../domain/equipment.entity.js";

export function toEquipmentDto(equipment: Equipment): EquipmentDto {
  return {
    id: equipment.id,
    tenantId: equipment.tenantId,
    name: equipment.name,
    status: equipment.status,
    pikvmHost: equipment.pikvmHost,
    pikvmUser: equipment.pikvmUser,
    targetOs: equipment.targetOs,
    keymap: equipment.keymap,
    mouseMode: equipment.mouseMode,
    screenWidth: equipment.screenWidth,
    screenHeight: equipment.screenHeight,
    cameraUrl: equipment.cameraUrl,
  };
}
