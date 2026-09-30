import type { EquipmentDto } from "@crop/shared";
import { Equipment } from "../domain/equipment.entity.js";

export function toEquipmentDto(equipment: Equipment): EquipmentDto {
  return {
    id: equipment.id,
    tenantId: equipment.tenantId,
    unitId: equipment.unitId,
    name: equipment.name,
    status: equipment.status,
    // A derived boolean, not the raw timestamp -- see EquipmentSchema's own comment, and
    // TenantDto.deactivated, which does the same thing for the same reason.
    deactivated: equipment.isDeactivated(),
    modality: equipment.modality,
    brand: equipment.brand,
    model: equipment.model,
    serialNumber: equipment.serialNumber,
    roomLabel: equipment.roomLabel,
    installedAt: equipment.installedAt,
    aeTitle: equipment.aeTitle,
    dicomIp: equipment.dicomIp,
    dicomPort: equipment.dicomPort,
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
