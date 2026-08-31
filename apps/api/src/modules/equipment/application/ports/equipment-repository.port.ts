import { Equipment } from "../../domain/equipment.entity.js";
import type { EquipmentStatus } from "@crop/shared";

export const EQUIPMENT_REPOSITORY = Symbol("EQUIPMENT_REPOSITORY");

export interface CreateEquipmentData {
  tenantId: string;
  name: string;
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
  getConnectionSecrets(id: string): Promise<EquipmentConnectionSecrets | null>;
}
