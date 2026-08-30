/**
 * Day 2 hardware spike (see README.md's demo script and docs/pikvm-integration.md).
 *
 * Verifies the PiKVM HID WebSocket and Direct-H.264 media WebSocket behave exactly as
 * documented and read from PiKVM's own source, against a REAL device -- catching any
 * discrepancy now rather than after more has been built on top of the assumption.
 *
 * Safety: by default this script sends NO keyboard or mouse input to the target machine.
 * It only observes state and calls the HID reset endpoint (a safe, idempotent operation --
 * see PiKvmHidClient.releaseAll). Sending an actual test keystroke is opt-in via
 * SPIKE_SEND_TEST_KEY=1, because the target could be a real clinical console in active use.
 *
 * Usage:
 *   SPIKE_PIKVM_HOST=https://<ip> SPIKE_PIKVM_USER=admin SPIKE_PIKVM_PASSWORD=... \
 *     pnpm --filter @crop/api exec tsx ../../infra/spike/pikvm-spike.ts
 *
 * Defaults to http://localhost:8443 / admin / admin, i.e. mock-pikvm-server.ts, if unset.
 */
import WebSocket from "ws";
import { PiKvmRestClient, PiKvmHidClient, type PiKvmCredentials } from "@crop/pikvm";

const credentials: PiKvmCredentials = {
  baseUrl: process.env.SPIKE_PIKVM_HOST ?? "http://localhost:8443",
  user: process.env.SPIKE_PIKVM_USER ?? "admin",
  password: process.env.SPIKE_PIKVM_PASSWORD ?? "admin",
  totpSecret: process.env.SPIKE_PIKVM_TOTP,
};
const SEND_TEST_KEY = process.env.SPIKE_SEND_TEST_KEY === "1";
const MEDIA_OBSERVE_SECONDS = 5;
const TIMEOUT_MS = 8000;

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name} -- ${detail}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function checkRest(): Promise<void> {
  const rest = new PiKvmRestClient(credentials);
  try {
    const info = await withTimeout(rest.getInfo(), TIMEOUT_MS, "GET /api/info");
    record("REST /api/info", true, `hid.online=${info.hid?.online}, mouse.absolute=${info.hid?.mouse.absolute}`);
  } catch (err) {
    record("REST /api/info", false, (err as Error).message);
  }
}

async function checkHid(): Promise<void> {
  const client = new PiKvmHidClient(credentials);
  const opened = new Promise<void>((resolve) => client.once("open", () => resolve()));
  const stateReceived = new Promise<import("@crop/pikvm").HidState>((resolve) => client.once("state", resolve));

  const started = performance.now();
  client.connect();

  try {
    await withTimeout(opened, TIMEOUT_MS, "HID WebSocket 'loop' event");
    record("HID WebSocket handshake", true, `ready in ${Math.round(performance.now() - started)}ms`);
  } catch (err) {
    record("HID WebSocket handshake", false, (err as Error).message);
    client.disconnect();
    return;
  }

  try {
    const state = await withTimeout(stateReceived, TIMEOUT_MS, "hid_state event");
    record("HID state event shape", true, `online=${state.online}, keyboard.online=${state.keyboard.online}, mouse.online=${state.mouse.online}`);
  } catch (err) {
    record("HID state event shape", false, (err as Error).message);
  }

  if (SEND_TEST_KEY) {
    console.log("SPIKE_SEND_TEST_KEY=1: sending an isolated ShiftLeft tap (down+up, types nothing)...");
    client.sendKey("ShiftLeft", true);
    await new Promise((r) => setTimeout(r, 100));
    client.sendKey("ShiftLeft", false);
    record("Test keystroke sent", true, "ShiftLeft down+up -- verify no stuck-key warning appears in PiKVM's own web UI");
  } else {
    console.log("Skipping test keystroke (SPIKE_SEND_TEST_KEY not set to 1) -- safe default for a real console.");
  }

  try {
    await withTimeout(client.releaseAll(), TIMEOUT_MS, "releaseAll (HID reset)");
    record("HID reset endpoint", true, "POST /api/hid/reset succeeded");
  } catch (err) {
    record("HID reset endpoint", false, (err as Error).message);
  }

  client.disconnect();
}

async function checkMedia(): Promise<void> {
  const wsUrl = credentials.baseUrl.replace(/^http/, "ws") + "/api/media/ws";
  const ws = new WebSocket(wsUrl, {
    headers: { "X-KVMD-User": credentials.user, "X-KVMD-Passwd": credentials.password },
    rejectUnauthorized: false,
  });
  ws.binaryType = "nodebuffer";

  const started = performance.now();
  let firstFrameAt: number | null = null;
  let frameCount = 0;
  let keyFrameCount = 0;
  let codecAnnounced: string | null = null;

  const handshakeDone = new Promise<void>((resolve, reject) => {
    ws.on("open", () => {});
    ws.on("error", (err) => reject(err));
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const parsed = JSON.parse(data.toString());
        if (parsed.event_type === "media") {
          const h264 = parsed.event?.video?.h264;
          if (!h264) {
            reject(new Error("PiKVM did not announce an h264 format -- is Direct H.264 mode available on this device?"));
            return;
          }
          codecAnnounced = `avc1.${h264.profile_level_id}`;
          ws.send(JSON.stringify({ event_type: "start", event: { type: "video", format: "h264" } }));
          resolve();
        }
        return;
      }
      // Binary frame, per the exact 2-byte header documented in docs/pikvm-integration.md.
      if (data[0] === 1) {
        if (firstFrameAt === null) firstFrameAt = performance.now();
        frameCount += 1;
        if (data[1]) keyFrameCount += 1;
      }
    });
  });

  try {
    await withTimeout(handshakeDone, TIMEOUT_MS, "media handshake");
    record("Media WebSocket handshake", true, `codec announced: ${codecAnnounced}`);
  } catch (err) {
    record("Media WebSocket handshake", false, (err as Error).message);
    ws.close();
    return;
  }

  console.log(`Observing frames for ${MEDIA_OBSERVE_SECONDS}s...`);
  await new Promise((r) => setTimeout(r, MEDIA_OBSERVE_SECONDS * 1000));

  if (firstFrameAt !== null) {
    record("First video frame received", true, `${Math.round(firstFrameAt - started)}ms after handshake started`);
    const fps = frameCount / MEDIA_OBSERVE_SECONDS;
    record(
      "Frame stream health",
      frameCount > 0,
      `${frameCount} frames in ${MEDIA_OBSERVE_SECONDS}s (~${fps.toFixed(1)}fps), ${keyFrameCount} keyframes`
    );
  } else {
    record("First video frame received", false, "No binary frame arrived within the observation window");
  }

  ws.close();
}

async function main(): Promise<void> {
  console.log(`Spiking against ${credentials.baseUrl} as ${credentials.user}\n`);

  await checkRest();
  await checkHid();
  await checkMedia();

  console.log("\n=== Summary ===");
  for (const r of results) console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name}`);
  const failed = results.filter((r) => !r.pass);
  console.log(failed.length === 0 ? "\nAll checks passed." : `\n${failed.length} check(s) failed -- see above.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Spike crashed:", err);
  process.exit(1);
});
