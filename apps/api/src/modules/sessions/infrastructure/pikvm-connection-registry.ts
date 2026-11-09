import { Injectable, Logger } from "@nestjs/common";
import { describeError, PiKvmDevice, PiKvmMediaRelay, type MouseButton, type PiKvmCredentials } from "@crop/pikvm";
import { MouseMode, type HidStatusEvent } from "@crop/shared";
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
  hidStatus: HidStatusEvent;
}

function offlineStatus(equipmentId: string): HidStatusEvent {
  return { equipmentId, connected: false, keyboardOnline: false, mouseOnline: false, mouseAbsolute: false };
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
  private hidStatusListener: ((status: HidStatusEvent) => void) | null = null;

  constructor(private readonly metrics: MetricsService) {}

  async acquire(equipmentId: string, secrets: EquipmentConnectionSecrets, mouseMode: MouseMode): Promise<void> {
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
    const entry: RegistryEntry = { device, credentials, refCount: 1, hidStatus: offlineStatus(equipmentId) };
    device.hid.on("open", () => this.setHidStatus(entry, { ...entry.hidStatus, connected: true }));
    // This app only ever sends absolute moves, which a PiKVM left in relative mode (`usb_rel`,
    // e.g. by someone using its own web UI) silently ignores -- so apply the equipment's
    // configured mode instead of trusting the device's. Once per HID connection.
    let mouseOutputApplied = false;
    device.hid.on("close", () => {
      mouseOutputApplied = false;
      this.setHidStatus(entry, offlineStatus(equipmentId));
    });
    device.hid.on("state", (state) => {
      this.setHidStatus(entry, {
        equipmentId,
        connected: true,
        keyboardOnline: state.online && state.keyboard.online,
        mouseOnline: state.online && state.mouse.online,
        mouseAbsolute: state.mouse.absolute,
      });
      const outputs = state.mouse.outputs;
      if (
        !mouseOutputApplied &&
        mouseMode === MouseMode.ABSOLUTE &&
        !state.mouse.absolute &&
        outputs?.available.includes("usb")
      ) {
        mouseOutputApplied = true;
        this.logger.log(`Switching equipment ${equipmentId}'s PiKVM mouse from ${outputs.active} to absolute (usb)`);
        device.setMouseOutput("usb").catch((err: Error) => {
          this.logger.warn(`Could not switch equipment ${equipmentId}'s PiKVM mouse to absolute: ${describeError(err)}`);
        });
      }
    });
    device.connect();
    this.entries.set(equipmentId, entry);
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

  getHidStatus(equipmentId: string): HidStatusEvent {
    return this.entries.get(equipmentId)?.hidStatus ?? offlineStatus(equipmentId);
  }

  onHidStatus(listener: (status: HidStatusEvent) => void): void {
    this.hidStatusListener = listener;
  }

  private setHidStatus(entry: RegistryEntry, next: HidStatusEvent): void {
    const prev = entry.hidStatus;
    entry.hidStatus = next;
    if (
      prev.connected === next.connected &&
      prev.keyboardOnline === next.keyboardOnline &&
      prev.mouseOnline === next.mouseOnline &&
      prev.mouseAbsolute === next.mouseAbsolute
    ) {
      return;
    }
    // Logged on change only: this is the one place a dead USB gadget or a relative-mode mouse
    // shows up server-side -- PiKVM accepts the input either way and nothing else errors.
    this.logger.log(
      `HID status for equipment ${next.equipmentId}: connected=${next.connected} keyboard=${next.keyboardOnline} mouse=${next.mouseOnline} absolute=${next.mouseAbsolute}`
    );
    // Only broadcast while the entry is still registered -- a released device's final "close"
    // must not tell a newer session on the same equipment that its input is offline.
    if (this.entries.get(next.equipmentId) === entry) this.hidStatusListener?.(next);
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
