import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { buildAuthHeaders, type PiKvmCredentials } from "./auth.js";
import { describeError } from "./describe-error.js";
import { PiKvmRestClient } from "./rest-client.js";

export type MouseButton = "left" | "middle" | "right" | "up" | "down";

export interface HidState {
  online: boolean;
  keyboard: { online: boolean; leds: { caps: boolean; num: boolean; scroll: boolean } };
  mouse: { online: boolean; absolute: boolean };
}

interface PiKvmHidClientEvents {
  open: [];
  close: [];
  error: [Error];
  state: [HidState];
}

const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;

function toWsUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/^http/, "ws") + path;
}

/**
 * Owns the single persistent connection to a PiKVM's `/api/ws` for HID input.
 *
 * This class is the safety boundary for the "stuck key/button" hazard described in
 * docs/pikvm-integration.md: every key and mouse button it sends as "pressed" is tracked,
 * and `releaseAll()` -- called on session end, takeover, disconnect, and idle timeout --
 * guarantees nothing is left physically held down on the clinical console.
 */
export class PiKvmHidClient extends EventEmitter<PiKvmHidClientEvents> {
  private ws: WebSocket | null = null;
  private readonly rest: PiKvmRestClient;
  private readonly pressedKeys = new Set<string>();
  private readonly pressedButtons = new Set<MouseButton>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ready = false;

  constructor(private readonly credentials: PiKvmCredentials) {
    super();
    this.rest = new PiKvmRestClient(credentials);
    // Node's EventEmitter crashes the entire process if an 'error' event has zero listeners.
    // For a class managing one persistent connection per PiKVM device in a multi-tenant API,
    // "PiKVM #1 is unreachable" must never take down every other tenant's session -- so this
    // class is safe-by-construction rather than trusting every call site (including this
    // package's own spike script, which is what caught this) to remember to attach one.
    // Consumers can still attach their own 'error' listener for real handling (e.g. marking
    // Equipment DEGRADED) -- this default only guarantees the process itself never crashes.
    this.on("error", (err) => console.error(`[PiKvmHidClient] ${credentials.baseUrl}:`, describeError(err)));
  }

  get isReady(): boolean {
    return this.ready;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  sendKey(code: string, state: boolean, finish = false): void {
    this.trackKey(code, state);
    this.send({ event_type: "key", event: { key: code, state, finish } });
  }

  sendMouseMove(x: number, y: number): void {
    this.send({ event_type: "mouse_move", event: { to: { x, y } } });
  }

  sendMouseRelative(deltas: Array<{ x: number; y: number }>): void {
    this.send({ event_type: "mouse_relative", event: { delta: deltas, squash: true } });
  }

  sendMouseButton(button: MouseButton, state: boolean): void {
    this.trackButton(button, state);
    this.send({ event_type: "mouse_button", event: { button, state } });
  }

  sendMouseWheel(deltaX: number, deltaY: number): void {
    this.send({ event_type: "mouse_wheel", event: { delta: { x: deltaX, y: deltaY } } });
  }

  /**
   * Releases every key/button this client believes is currently pressed, then calls the
   * device-wide HID reset. Idempotent and safe to call even if nothing is pressed.
   */
  async releaseAll(): Promise<void> {
    for (const code of this.pressedKeys) {
      this.send({ event_type: "key", event: { key: code, state: false, finish: true } });
    }
    for (const button of this.pressedButtons) {
      this.send({ event_type: "mouse_button", event: { button, state: false } });
    }
    this.pressedKeys.clear();
    this.pressedButtons.clear();
    await this.rest.reset().catch((err: unknown) => this.emit("error", err as Error));
  }

  async printText(text: string, keymap: string): Promise<void> {
    await this.rest.printText(text, keymap);
  }

  private trackKey(code: string, state: boolean): void {
    if (state) this.pressedKeys.add(code);
    else this.pressedKeys.delete(code);
  }

  private trackButton(button: MouseButton, state: boolean): void {
    if (state) this.pressedButtons.add(button);
    else this.pressedButtons.delete(button);
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
    // Silently dropped if not connected: the reconnect loop will restore state, and the
    // caller-side pressed-key tracking above is what `releaseAll` relies on to clean up once
    // we're back online -- there is no safe way to "queue and replay" HID input after a gap.
  }

  private open(): void {
    const url = toWsUrl(this.credentials.baseUrl, "/api/ws?stream=1");
    const ws = new WebSocket(url, {
      headers: buildAuthHeaders(this.credentials),
      rejectUnauthorized: false, // PiKVM ships a self-signed cert by default
    });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
    });

    ws.on("message", (data: Buffer) => this.handleMessage(data));

    ws.on("close", () => {
      this.ready = false;
      this.emit("close");
      this.pressedKeys.clear();
      this.pressedButtons.clear();
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => this.emit("error", err));
  }

  private handleMessage(data: Buffer): void {
    let parsed: { event_type?: string; event?: unknown };
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (parsed.event_type === "loop") {
      this.ready = true;
      this.emit("open");
    } else if (parsed.event_type === "hid_state") {
      this.emit("state", parsed.event as HidState);
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
}
