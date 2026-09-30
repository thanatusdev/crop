import type { ExamModality, MouseMode, TargetOs } from "@crop/shared";

export interface EquipmentChanges {
  name?: string;
  // `undefined` = leave unchanged; `null` explicitly unassigns the unit. Validated against
  // the equipment's own tenant in UpdateEquipmentHandler, same as at creation time.
  unitId?: string | null;
  // Clinical identity: optional (leave unchanged) but deliberately not nullable -- an edit
  // may correct a brand or a room, never blank one out. See UpdateEquipmentRequestSchema for
  // the full reasoning; the rule is enforced at the contract boundary and mirrored here so
  // that an internal caller (a script, a future handler) can't bypass it either.
  modality?: ExamModality;
  brand?: string;
  model?: string;
  serialNumber?: string;
  roomLabel?: string;
  installedAt?: Date;
  // DICOM node identity: nullable, because "this device has no PACS entry after all" is a
  // legitimate correction.
  aeTitle?: string | null;
  dicomIp?: string | null;
  dicomPort?: number | null;
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
