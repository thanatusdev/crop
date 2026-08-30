import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];

  constructor(_url: string, _opts: unknown) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

vi.mock("ws", () => ({ default: FakeWebSocket }));

// Import after the mock is registered so hid-client.ts receives the fake implementation.
const { PiKvmHidClient } = await import("../src/hid-client.js");

function lastSent(ws: FakeWebSocket): unknown {
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

describe("PiKvmHidClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.restoreAllMocks();
  });

  it("sends a key event in PiKVM's exact wire shape", () => {
    const client = new PiKvmHidClient({ baseUrl: "https://pikvm", user: "admin", password: "admin" });
    client.connect();
    const ws = FakeWebSocket.instances[0];

    client.sendKey("ControlLeft", true, false);

    expect(lastSent(ws)).toEqual({ event_type: "key", event: { key: "ControlLeft", state: true, finish: false } });
  });

  it("tracks pressed keys and releases exactly those on releaseAll (the stuck-key safety guarantee)", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "" }) as unknown as typeof fetch;

    const client = new PiKvmHidClient({ baseUrl: "https://pikvm", user: "admin", password: "admin" });
    client.connect();
    const ws = FakeWebSocket.instances[0];

    client.sendKey("ControlLeft", true);
    client.sendKey("KeyC", true);
    client.sendKey("KeyC", false); // released before session end -- should NOT be released twice
    client.sendMouseButton("left", true);

    ws.sent = []; // clear history, only inspect what releaseAll emits
    await client.releaseAll();

    const releasedKeyEvents = ws.sent.map((s) => JSON.parse(s)).filter((e) => e.event_type === "key");
    const releasedButtonEvents = ws.sent.map((s) => JSON.parse(s)).filter((e) => e.event_type === "mouse_button");

    expect(releasedKeyEvents).toEqual([
      { event_type: "key", event: { key: "ControlLeft", state: false, finish: true } },
    ]);
    expect(releasedButtonEvents).toEqual([{ event_type: "mouse_button", event: { button: "left", state: false } }]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/hid/reset"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("clears pressed-key tracking on an unexpected disconnect, so a stale key isn't released twice on reconnect", () => {
    const client = new PiKvmHidClient({ baseUrl: "https://pikvm", user: "admin", password: "admin" });
    client.connect();
    const ws = FakeWebSocket.instances[0];

    client.sendKey("ShiftLeft", true);
    ws.close();

    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1);
  });

  it("never crashes the process on a connection error, even with no external listener attached", () => {
    // Regression test: Node's EventEmitter throws (crashing the whole process) if an
    // 'error' event has zero listeners. A single unreachable PiKVM must never take down
    // every other tenant's session in the real API -- caught by infra/spike/pikvm-spike.ts
    // pointed at an unreachable host, see docs/architecture.md.
    const errorLogSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const client = new PiKvmHidClient({ baseUrl: "https://pikvm", user: "admin", password: "admin" });
    client.connect(); // deliberately NOT attaching client.on('error', ...) here
    const ws = FakeWebSocket.instances[0];

    expect(() => ws.emit("error", new Error("ECONNREFUSED"))).not.toThrow();
    expect(errorLogSpy).toHaveBeenCalled();
  });
});
