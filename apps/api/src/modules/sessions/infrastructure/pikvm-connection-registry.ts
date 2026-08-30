import { Injectable, Logger } from "@nestjs/common";
import { describeError, PiKvmDevice, PiKvmMediaRelay, type MouseButton, type PiKvmCredentials } from "@crop/pikvm";
import { MetricsService } from "../../../shared/infrastructure/metrics/metrics.service.js";
import type {
  EquipmentConnectionSecrets,
  PiKvmGatewayPort,
} from "../application/ports/pikvm-gateway.port.js";

interface RegistryEntry {
  device: PiKvmDevice;
  credentials: PiKvmCredentials;
  /** Number of active sessions currently using this equipment. Disconnects at zero. */
  refCount: number;
}

/**
 * One persistent HID connection per piece of equipment, shared by whichever session
 * currently owns it, reference-counted so the connection survives a takeover (same
 * equipment, same session, different controller) and is torn down only when the session
 * genuinely ends. This is the concrete implementation behind PiKvmGatewayPort -- see that
 * port's docstring, and SessionRuntimePort's, for why this is in-process rather than
 * distributed for the MVP.
 */
@Injectable()
export class PiKvmConnectionRegistry implements PiKvmGatewayPort {
  private readonly logger = new Logger(PiKvmConnectionRegistry.name);
  private readonly entries = new Map<string, RegistryEntry>();

  constructor(private readonly metrics: MetricsService) {}

  async acquire(equipmentId: string, secrets: EquipmentConnectionSecrets): Promise<void> {
    const existing = this.entries.get(equipmentId);
    if (existing) {
      existing.refCount += 1;
      return;
    }

    const credentials: PiKvmCredentials = {
      baseUrl: secrets.baseUrl,
      user: secrets.user,
      password: secrets.password,
      totpSecret: secrets.totpSecret,
    };
    const device = new PiKvmDevice(credentials);
    // @crop/pikvm's classes are safe-by-construction against the "unhandled 'error' event
    // crashes the process" hazard (see their own constructors), but this listener is still
    // worth attaching: it's what turns a connection failure into an entry in this specific
    // equipment's logs, correlated by equipmentId, rather than a generic library-level line.
    device.hid.on("error", (err) => {
      this.logger.warn(`HID connection issue for equipment ${equipmentId}: ${describeError(err)}`);
      this.metrics.pikvmConnectionErrorsTotal.inc({ equipment_id: equipmentId });
    });
    device.connect();
    this.entries.set(equipmentId, { device, credentials, refCount: 1 });
    this.logger.log(`Acquired PiKVM connection for equipment ${equipmentId}`);
  }

  async release(equipmentId: string): Promise<void> {
    const entry = this.entries.get(equipmentId);
    if (!entry) return;

    entry.refCount -= 1;
    if (entry.refCount > 0) return;

    this.entries.delete(equipmentId);
    await entry.device.disconnect();
    this.logger.log(`Released PiKVM connection for equipment ${equipmentId}`);
  }

  sendKey(equipmentId: string, code: string, state: boolean, finish: boolean): void {
    this.entries.get(equipmentId)?.device.hid.sendKey(code, state, finish);
  }

  sendMouseMove(equipmentId: string, x: number, y: number): void {
    this.entries.get(equipmentId)?.device.hid.sendMouseMove(x, y);
  }

  sendMouseButton(equipmentId: string, button: MouseButton, state: boolean): void {
    this.entries.get(equipmentId)?.device.hid.sendMouseButton(button, state);
  }

  sendMouseWheel(equipmentId: string, deltaX: number, deltaY: number): void {
    this.entries.get(equipmentId)?.device.hid.sendMouseWheel(deltaX, deltaY);
  }

  async printText(equipmentId: string, text: string, keymap: string): Promise<void> {
    await this.entries.get(equipmentId)?.device.hid.printText(text, keymap);
  }

  async releaseAllInput(equipmentId: string): Promise<void> {
    await this.entries.get(equipmentId)?.device.hid.releaseAll();
  }

  createMediaRelay(equipmentId: string): PiKvmMediaRelay | null {
    const entry = this.entries.get(equipmentId);
    if (!entry) return null;
    const relay = new PiKvmMediaRelay(entry.credentials);
    relay.on("error", (err) => {
      this.logger.warn(`Media relay issue for equipment ${equipmentId}: ${describeError(err)}`);
      this.metrics.pikvmConnectionErrorsTotal.inc({ equipment_id: equipmentId });
    });
    return relay;
  }

  async captureSnapshot(equipmentId: string): Promise<Buffer | null> {
    const entry = this.entries.get(equipmentId);
    if (!entry) return null;
    try {
      return await entry.device.captureSnapshot();
    } catch (err) {
      // A failed snapshot is never worth taking the equipment offline over -- the health
      // poller and the HID error listener above are what surface a genuinely dead device.
      this.logger.warn(`Snapshot capture failed for equipment ${equipmentId}: ${describeError(err as Error)}`);
      return null;
    }
  }
}
