import type { PiKvmMediaRelay } from "@crop/pikvm";

export const PIKVM_GATEWAY = Symbol("PIKVM_GATEWAY");

export interface EquipmentConnectionSecrets {
  baseUrl: string;
  user: string;
  password: string;
  totpSecret?: string;
}

/**
 * The only way the sessions module talks to a physical (or simulated) PiKVM. Hides
 * connection lifecycle (one persistent HID socket per equipment, shared across whichever
 * session currently owns that equipment) behind operations expressed in terms the
 * application layer cares about, so no handler imports `@crop/pikvm` directly.
 */
export interface PiKvmGatewayPort {
  /** Idempotent: opens the device connection on first use, reuses it on subsequent calls. */
  acquire(equipmentId: string, secrets: EquipmentConnectionSecrets): Promise<void>;
  /** Called when a session ends; disconnects the device once nothing references it anymore. */
  release(equipmentId: string): Promise<void>;

  sendKey(equipmentId: string, code: string, state: boolean, finish: boolean): void;
  sendMouseMove(equipmentId: string, x: number, y: number): void;
  sendMouseButton(equipmentId: string, button: "left" | "middle" | "right" | "up" | "down", state: boolean): void;
  sendMouseWheel(equipmentId: string, deltaX: number, deltaY: number): void;
  printText(equipmentId: string, text: string, keymap: string): Promise<void>;
  /** Releases every physically-held key/button and calls the device-wide HID reset. */
  releaseAllInput(equipmentId: string): Promise<void>;

  /** For the raw video relay: creates a fresh PiKvmMediaRelay for an already-acquired device.
   * One relay instance per browser video connection -- PiKVM's own media server (Janus) is
   * designed to serve multiple concurrent viewers, so there is no need to fan a single
   * upstream connection out to multiple browsers ourselves. */
  createMediaRelay(equipmentId: string): PiKvmMediaRelay | null;

  /** A single JPEG snapshot of the current console frame, for session-replay evidence. */
  captureSnapshot(equipmentId: string): Promise<Buffer | null>;
}
