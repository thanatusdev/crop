import { Agent } from "undici";
import { buildAuthHeaders, type PiKvmCredentials } from "./auth.js";

const DEFAULT_TIMEOUT_MS = 5000;

// PiKVM ships a self-signed cert by default (confirmed against real hardware: a stock
// PiKVM Mini's HTTPS cert fails Node's default chain validation with
// DEPTH_ZERO_SELF_SIGNED_CERT). Node's global `fetch` is undici under the hood and honours
// a `dispatcher` option, so a dedicated Agent with certificate verification relaxed gets
// this REST client to the same trust posture PiKvmHidClient/PiKvmMediaRelay already use via
// `ws`'s `rejectUnauthorized: false` -- verification is handled at the ZTNA/reverse-proxy
// layer for production hosts, not per-request here.
const INSECURE_TLS_AGENT = new Agent({ connect: { rejectUnauthorized: false } });

/**
 * Deliberately narrow: this client only implements the endpoints the platform actually needs.
 * `/api/atx/*` and `/api/msd/*` are intentionally absent -- see docs/pikvm-integration.md --
 * so a power-off or virtual-USB-mount call is unreachable by construction, not merely hidden
 * behind a permission check that could be misconfigured.
 */
export class PiKvmRestClient {
  constructor(private readonly credentials: PiKvmCredentials) {}

  async reset(): Promise<void> {
    await this.post("/api/hid/reset");
  }

  async printText(text: string, keymap: string): Promise<void> {
    await this.post(`/api/hid/print?keymap=${encodeURIComponent(keymap)}`, text);
  }

  /**
   * Confirmed against real hardware (a PiKVM Mini, kvmd 4.61): `/api/info` has no `hid` key
   * at all, filtered or not -- `?fields=hid` is itself rejected with a `ValidatorError`. HID
   * state lives at its own `GET /api/hid` endpoint and has the same shape this method's
   * callers expect from the old (incorrect) `?fields=hid,hw` assumption, so the two requests
   * are combined here rather than pushing this split onto every caller.
   */
  async getInfo(): Promise<PiKvmInfo> {
    const [hid, info] = await Promise.all([
      this.get<PiKvmInfo["hid"]>("/api/hid"),
      this.get<Pick<PiKvmInfo, "hw">>("/api/info?fields=hw"),
    ]);
    return { hid, hw: info.hw };
  }

  async getSnapshotJpeg(): Promise<Buffer> {
    const res = await this.request("/api/streamer/snapshot?allow_offline=1", "GET");
    return Buffer.from(await res.arrayBuffer());
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.request(path, "GET");
    const body = (await res.json()) as { ok: boolean; result: T };
    return body.result;
  }

  private async post(path: string, body?: string): Promise<void> {
    await this.request(path, "POST", body);
  }

  private async request(path: string, method: string, body?: string): Promise<Response> {
    const url = `${this.credentials.baseUrl}${path}`;
    // `dispatcher` is an undici (Node-fetch-implementation) extension the DOM-derived
    // `RequestInit` type doesn't know about, even though the global `fetch` it types
    // honours it at runtime -- widen the init type locally rather than losing type-checking
    // on the rest of this call's options.
    const init: RequestInit & { dispatcher?: Agent } = {
      method,
      headers: buildAuthHeaders(this.credentials),
      body,
      dispatcher: INSECURE_TLS_AGENT,
      // A timeout here is not optional: an unreachable device otherwise hangs this fetch
      // for however long the OS's own TCP retry behaviour takes (which can be well over a
      // minute), and `PiKvmHidClient.releaseAll()` -- the stuck-key safety mechanism called
      // on every session end, takeover, and disconnect -- awaits exactly this call. A slow
      // timeout there would mean "end session" hanging in the operator's browser for as
      // long as the network stack takes to give up, on precisely the safety-critical path
      // that must be fast and reliable. Caught by an e2e test timing out against a
      // deliberately unreachable fixture host, not by inspection.
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    };
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new PiKvmRequestError(path, 0, `Request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
      }
      throw err;
    }
    if (!res.ok) {
      throw new PiKvmRequestError(path, res.status, await res.text().catch(() => ""));
    }
    return res;
  }
}

export class PiKvmRequestError extends Error {
  constructor(
    public readonly path: string,
    public readonly statusCode: number,
    public readonly body: string
  ) {
    super(`PiKVM request to ${path} failed with ${statusCode}: ${body}`);
  }
}

export interface PiKvmInfo {
  hid?: {
    online: boolean;
    keyboard: { online: boolean; leds: { caps: boolean; num: boolean; scroll: boolean } };
    mouse: { online: boolean; absolute: boolean };
  };
  hw?: {
    health: { temp: { cpu: number } };
  };
}
