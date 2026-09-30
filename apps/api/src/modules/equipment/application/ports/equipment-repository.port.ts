import { Equipment } from "../../domain/equipment.entity.js";
import type { EquipmentStatus } from "@crop/shared";

export const EQUIPMENT_REPOSITORY = Symbol("EQUIPMENT_REPOSITORY");

export interface CreateEquipmentData {
  tenantId: string;
  // Always resolved by the time this reaches the repository -- see
  // CreateEquipmentHandler's own docstring on why this port itself doesn't default it.
  unitId: string;
  name: string;
  // Clinical identity. Non-null here even though the columns are nullable: the nullable
  // columns exist for rows that predate the registration screen, and nothing may add to that
  // set (see the equipment_clinical_identity migration).
  modality: Equipment["modality"];
  brand: string;
  model: string;
  serialNumber: string;
  roomLabel: string;
  installedAt: Date;
  // DICOM node identity: optional even for a new row, because nothing in this platform reads
  // these to actually talk to a PACS.
  aeTitle: string | null;
  dicomIp: string | null;
  dicomPort: number | null;
  pikvmHost: string;
  pikvmUser: string;
  pikvmPasswordCiphertext: string;
  pikvmTotpSecretCiphertext: string | null;
  targetOs: Equipment["targetOs"];
  keymap: string;
  mouseMode: Equipment["mouseMode"];
  screenWidth: number;
  screenHeight: number;
  cameraUrl: string | null;
}

/** Only what's needed to open a device connection. Ciphertext, decrypted by the caller. */
export interface EquipmentConnectionSecrets {
  pikvmHost: string;
  pikvmUser: string;
  pikvmPasswordCiphertext: string;
  pikvmTotpSecretCiphertext: string | null;
}

/**
 * Every field optional -- a real partial update. `pikvmPasswordCiphertext` absent means
 * "leave the stored credential unchanged"; the caller (UpdateEquipmentHandler) only sets
 * this key at all when a new plaintext password was actually provided, already encrypted.
 */
export interface UpdateEquipmentData {
  name?: string;
  // `undefined` means "leave unchanged" (same convention as every other optional field
  // here); `null` is a real value the caller can set explicitly (UpdateEquipmentHandler
  // still validates a non-null unitId belongs to the equipment's own tenant before this
  // is ever called).
  unitId?: string | null;
  // Clinical identity: optional (leave unchanged) but never nullable -- an edit must not be
  // able to blank out the brand/serial of a device that has them, which would grow the
  // historical-null set the create path exists to stop growing. Enforced at the contract
  // boundary too; see UpdateEquipmentRequestSchema's docstring.
  modality?: Equipment["modality"];
  brand?: string;
  model?: string;
  serialNumber?: string;
  roomLabel?: string;
  installedAt?: Date;
  // DICOM node identity, in contrast, IS nullable: "this device has no PACS entry after all"
  // is a legitimate correction to record.
  aeTitle?: string | null;
  dicomIp?: string | null;
  dicomPort?: number | null;
  pikvmHost?: string;
  pikvmUser?: string;
  pikvmPasswordCiphertext?: string;
  targetOs?: Equipment["targetOs"];
  keymap?: string;
  mouseMode?: Equipment["mouseMode"];
  screenWidth?: number;
  screenHeight?: number;
  cameraUrl?: string | null;
}

export interface EquipmentRepositoryPort {
  create(data: CreateEquipmentData): Promise<Equipment>;
  findById(id: string): Promise<Equipment | null>;
  listByTenant(tenantId: string): Promise<Equipment[]>;
  /** Used only by the health-poller cron, which must check every device regardless of tenant. */
  listAll(): Promise<Equipment[]>;
  update(id: string, data: UpdateEquipmentData): Promise<Equipment>;
  updateStatus(id: string, status: EquipmentStatus): Promise<void>;
  /**
   * Retire / un-retire a device. Separate from `updateStatus` on purpose: that writes the
   * health field the poller owns, this writes the lifecycle field only an admin owns. Folding
   * them into one method would invite exactly the confusion schema.prisma's comment on
   * `deactivatedAt` warns about.
   */
  setDeactivated(id: string, deactivated: boolean): Promise<Equipment>;
  getConnectionSecrets(id: string): Promise<EquipmentConnectionSecrets | null>;
}
