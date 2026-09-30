import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;

  constructor(_url: string, _opts: unknown) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(_data: unknown, _opts: unknown) {}

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
// `WebSocket.OPEN` is read as a static property off the imported default -- attach it the
// same way `ws`'s real export does, so `isOpen`'s `this.upstream?.readyState === WebSocket.OPEN`
// check compiles and behaves identically against the fake.
(FakeWebSocket as unknown as { OPEN: number }).OPEN = 1;

vi.mock("ws", () => ({ default: FakeWebSocket }));

// Import after the mock is registered so media-relay.ts receives the fake implementation.
const { PiKvmMediaRelay } = await import("../src/media-relay.js");

describe("PiKvmMediaRelay", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.restoreAllMocks();
  });

  it("emits 'open' once the upstream connection opens, and reports isOpen accordingly", async () => {
    const relay = new PiKvmMediaRelay({ baseUrl: "https://pikvm", user: "admin", password: "admin" });
    const openPromise = new Promise((resolve) => relay.on("open", resolve));
    relay.connect();

    await openPromise;
    expect(relay.isOpen).toBe(true);
  });

  it("closes the upstream connection and reports isOpen as false after disconnect", async () => {
    const relay = new PiKvmMediaRelay({ baseUrl: "https://pikvm", user: "admin", password: "admin" });
    const openPromise = new Promise((resolve) => relay.on("open", resolve));
    relay.connect();
    await openPromise;

    relay.disconnect();
    expect(relay.isOpen).toBe(false);
  });

  it("forwards device messages to a handler registered via onDeviceMessage BEFORE connect() -- the exact order MediaStreamServer uses in production", () => {
    // Regression test: found via a live browser session against real PiKVM hardware, where
    // the video stayed stuck on "connecting" forever with zero errors anywhere, because
    // onDeviceMessage's handler was attached to `this.upstream` at call time -- still null
    // at that point, since MediaStreamServer registers it before calling relay.connect().
    const relay = new PiKvmMediaRelay({ baseUrl: "https://pikvm", user: "admin", password: "admin" });
    const received: Array<{ data: unknown; isBinary: boolean }> = [];
    relay.onDeviceMessage((data, isBinary) => received.push({ data, isBinary }));

    relay.connect();
    const ws = FakeWebSocket.instances[0];
    ws.emit("message", Buffer.from([1, 1, 0xaa]), true);

    expect(received).toEqual([{ data: Buffer.from([1, 1, 0xaa]), isBinary: true }]);
  });

  it("never crashes the process on a connection error, even with no external listener attached", () => {
    // Regression test, same reasoning and same finding as PiKvmHidClient's own version of
    // this test (packages/pikvm/tests/hid-client.test.ts) -- this class has the identical
    // "attach a default error listener in the constructor" pattern, but had zero test
    // coverage of its own until now, found by a verification pass on README claims rather
    // than by this class's own behavior ever actually being in question.
    const errorLogSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const relay = new PiKvmMediaRelay({ baseUrl: "https://pikvm", user: "admin", password: "admin" });
    relay.connect(); // deliberately NOT attaching relay.on('error', ...) here
    const ws = FakeWebSocket.instances[0];

    expect(() => ws.emit("error", new Error("ECONNREFUSED"))).not.toThrow();
    expect(errorLogSpy).toHaveBeenCalled();
  });
});
