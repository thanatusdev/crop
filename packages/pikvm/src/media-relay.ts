import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import { buildAuthHeaders, type PiKvmCredentials } from "./auth.js";
import { describeError } from "./describe-error.js";

interface PiKvmMediaRelayEvents {
  open: [];
  close: [];
  error: [Error];
}

function toWsUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/^http/, "ws") + path;
}

/**
 * A pure byte-level relay to PiKVM's Direct-H.264 media WebSocket (`/api/media/ws`).
 *
 * Deliberately does *not* implement the media handshake or decode anything: the browser
 * already speaks this protocol correctly (it's PiKVM's own reference client -- see
 * docs/pikvm-integration.md), so re-implementing it server-side would only add a place for
 * the two ends to drift apart, and any server-side transformation of video bytes would burn
 * part of the sub-200ms latency budget for no benefit.
 *
 * What this class *does* add, which the browser cannot do safely on its own: the browser
 * never receives PiKVM's base URL or credentials, and every relayed session is tied to an
 * authenticated platform session so video access is still gated by the same audit/authz
 * boundary as HID input.
 */
export class PiKvmMediaRelay extends EventEmitter<PiKvmMediaRelayEvents> {
  private upstream: WebSocket | null = null;
  // `onDeviceMessage` is the platform's own registration API (called once by
  // MediaStreamServer per browser connection), not a raw `ws` listener -- stored here and
  // (re)attached whenever `connect()` creates a socket, rather than attached directly to
  // `this.upstream` at call time, because MediaStreamServer registers it *before* calling
  // `connect()`. Confirmed against a live browser session against real PiKVM hardware: with
  // the previous `this.upstream?.on(...)` implementation, `upstream` was still null at that
  // point, so the handler silently attached to nothing and the browser saw zero frames --
  // no error anywhere, just a video element stuck on "connecting" forever.
  private deviceMessageHandler: ((data: RawData, isBinary: boolean) => void) | null = null;

  constructor(private readonly credentials: PiKvmCredentials) {
    super();
    // Same reasoning as PiKvmHidClient: Node crashes the process on an unhandled 'error'
    // event, and this class must never take the whole API down just because one PiKVM's
    // media socket had a network blip. See that class's constructor for the full rationale.
    this.on("error", (err) => console.error(`[PiKvmMediaRelay] ${credentials.baseUrl}:`, describeError(err)));
  }

  connect(): void {
    const url = toWsUrl(this.credentials.baseUrl, "/api/media/ws");
    const ws = new WebSocket(url, {
      headers: buildAuthHeaders(this.credentials),
      rejectUnauthorized: false,
    });
    ws.binaryType = "nodebuffer";
    this.upstream = ws;

    ws.on("open", () => this.emit("open"));
    ws.on("close", () => this.emit("close"));
    ws.on("error", (err: Error) => this.emit("error", err));
    if (this.deviceMessageHandler) {
      const handler = this.deviceMessageHandler;
      ws.on("message", (data: RawData, isBinary: boolean) => handler(data, isBinary));
    }
  }

  disconnect(): void {
    this.upstream?.close();
    this.upstream = null;
  }

  get isOpen(): boolean {
    return this.upstream?.readyState === WebSocket.OPEN;
  }

  /** Forwards a message from the browser client straight to PiKVM. */
  sendToDevice(data: RawData, isBinary: boolean): void {
    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(data, { binary: isBinary });
    }
  }

  /** Registers the callback that forwards PiKVM's frames back to the browser client. */
  onDeviceMessage(handler: (data: RawData, isBinary: boolean) => void): void {
    this.deviceMessageHandler = handler;
    this.upstream?.on("message", (data: RawData, isBinary: boolean) => handler(data, isBinary));
  }
}
