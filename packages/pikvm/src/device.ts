import { PiKvmHidClient } from "./hid-client.js";
import { PiKvmMediaRelay } from "./media-relay.js";
import { PiKvmRestClient, type PiKvmInfo } from "./rest-client.js";
import type { PiKvmCredentials } from "./auth.js";

/**
 * Aggregates the three ways the platform talks to one physical PiKVM: the persistent HID
 * WebSocket, the video relay, and one-off REST calls. One instance per piece of Equipment,
 * held for the lifetime of an active session -- see apps/api's PiKvmDeviceRegistry, which is
 * the only thing allowed to construct these (the stateful HID connection cannot safely be
 * shared or duplicated across concurrent sessions on the same device).
 */
export class PiKvmDevice {
  readonly hid: PiKvmHidClient;
  readonly media: PiKvmMediaRelay;
  private readonly rest: PiKvmRestClient;

  constructor(private readonly credentials: PiKvmCredentials) {
    this.hid = new PiKvmHidClient(credentials);
    this.media = new PiKvmMediaRelay(credentials);
    this.rest = new PiKvmRestClient(credentials);
  }

  connect(): void {
    this.hid.connect();
  }

  /** Full stop: releases any held input, tears down HID and video connections. */
  async disconnect(): Promise<void> {
    await this.hid.releaseAll();
    this.hid.disconnect();
    this.media.disconnect();
  }

  async checkHealth(): Promise<PiKvmInfo> {
    return this.rest.getInfo();
  }

  async captureSnapshot(): Promise<Buffer> {
    return this.rest.getSnapshotJpeg();
  }
}
