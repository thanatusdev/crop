/**
 * Load-tests the input pipeline: N concurrent sessions, each sending mouse-move events at a
 * configurable rate (default 60/sec, matching the client-side throttle documented in
 * docs/architecture.md), for a configurable duration -- against the REAL running API and a
 * REAL Socket.io connection per session, not a synthetic in-process benchmark.
 *
 * What this validates: whether ProcessHidInputHandler's own overhead
 * (crop_hid_forward_duration_seconds, see MetricsService) stays a negligible fraction of the
 * 200ms budget under realistic concurrent load, and whether the audit buffer keeps up
 * (crop_audit_flush_batch_sessions) rather than growing unboundedly.
 *
 * Usage (API and Postgres/Redis must already be running):
 *   node --env-file=apps/api/.env --experimental-strip-types ...
 *   (or, simplest) pnpm loadtest:input   -- see root package.json, which sets this up correctly
 *
 * Env vars: LOADTEST_SESSIONS (default 20), LOADTEST_DURATION_SECONDS (default 20),
 * LOADTEST_EVENTS_PER_SECOND (default 60), LOADTEST_API_URL (default http://localhost:3000).
 *
 * Needs `CREDENTIALS_ENCRYPTION_KEY` in its environment, matching the running API's: fixture
 * equipment must have a genuinely decryptable `pikvmPasswordCiphertext`, since
 * StartSessionHandler decrypts it via GetEquipmentConnectionSecretsQuery before this script's
 * deliberately-unreachable PIKVM_HOST is ever dialled -- a placeholder string there would
 * throw before a session even started, not just fail the eventual (irrelevant) HID connect.
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import * as argon2 from "argon2";
import * as OTPAuth from "otpauth";
import { io, type Socket } from "socket.io-client";

// Loads apps/api/.env (DATABASE_URL, CREDENTIALS_ENCRYPTION_KEY, ...) so this script shares
// the exact same config as the running API it's about to load-test, without needing a
// separate dotenv dependency -- process.loadEnvFile is a built-in as of Node 20.6.
process.loadEnvFile(resolve(__dirname, "../../apps/api/.env"));

const API_URL = process.env.LOADTEST_API_URL ?? "http://localhost:3000";
const SESSION_COUNT = Number(process.env.LOADTEST_SESSIONS ?? 20);
const DURATION_SECONDS = Number(process.env.LOADTEST_DURATION_SECONDS ?? 20);
const EVENTS_PER_SECOND = Number(process.env.LOADTEST_EVENTS_PER_SECOND ?? 60);
// Deliberately non-routable (TEST-NET-1): this load test measures OUR pipeline's overhead
// (gateway -> CommandBus -> PiKvmGatewayPort.sendMouseMove), not real device I/O -- see
// PiKvmConnectionRegistry.sendMouseMove, which is fire-and-forget over an already-open
// WebSocket and returns immediately regardless of whether the device is actually reachable.
const PIKVM_HOST = "https://192.0.2.1";

/** Mirrors EncryptionService.encrypt() exactly (packages/api/src/shared/.../encryption.service.ts)
 * -- duplicated rather than imported because importing Nest-DI-managed application code into
 * a standalone script hits the same dual-module-instance hazard documented in
 * docs/architecture.md's e2e testing section, for a class this trivial to just mirror. */
function encryptPlaceholder(plaintext: string): string {
  const key = Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY must be set (base64, 32 bytes) -- see apps/api/.env");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, ciphertext, authTag].map((b) => b.toString("base64")).join(".");
}

interface SimulatedSession {
  index: number;
  socket: Socket;
  sessionId: string;
  sentCount: number;
}

async function main(): Promise<void> {
  console.log(`Load test: ${SESSION_COUNT} concurrent sessions x ${EVENTS_PER_SECOND} events/sec for ${DURATION_SECONDS}s`);
  console.log(`Target: ${API_URL}\n`);

  const prisma = new PrismaClient();
  const tenant = await prisma.tenant.create({ data: { name: `LoadTest-${new Date().toISOString()}`, type: "CLINIC" } });
  console.log(`Created tenant ${tenant.id} (safe to ignore/leave -- see infra/loadtest's own docstring on cleanup)`);

  console.log(`Provisioning ${SESSION_COUNT} operators + equipment...`);
  const sessions: SimulatedSession[] = [];

  for (let i = 0; i < SESSION_COUNT; i++) {
    const email = `loadtest-${i}-${crypto.randomUUID()}@test.crop.health`;
    const password = "LoadTest123!";
    const secret = new OTPAuth.Secret({ size: 20 }).base32;

    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        role: "OPERATOR",
        mfaSecret: secret,
        mfaEnabledAt: new Date(),
      },
    });

    const equipment = await prisma.equipment.create({
      data: {
        tenantId: tenant.id,
        name: `LoadTest-Equipment-${i}`,
        pikvmHost: PIKVM_HOST,
        pikvmUser: "admin",
        pikvmPasswordCiphertext: encryptPlaceholder("unused"), // see encryptPlaceholder's docstring above
        status: "ONLINE", // bypasses waiting for PiKvmHealthPoller's next cron tick
        targetOs: "WINDOWS",
        keymap: "en-us",
        mouseMode: "ABSOLUTE",
      },
    });

    const loginRes = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, clientOs: "MACOS" }),
    });
    const { mfaToken } = (await loginRes.json()) as { mfaToken: string };

    const code = new OTPAuth.TOTP({ secret }).generate();
    const verifyRes = await fetch(`${API_URL}/auth/mfa/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken, code }),
    });
    const { accessToken } = (await verifyRes.json()) as { accessToken: string };

    const startRes = await fetch(`${API_URL}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ equipmentId: equipment.id }),
    });
    const session = (await startRes.json()) as { id: string };

    const socket = io(API_URL, {
      path: "/rt",
      transports: ["websocket"],
      auth: { token: accessToken },
      autoConnect: false,
      perMessageDeflate: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => {
        socket.emit("session:join", { sessionId: session.id });
        resolve();
      });
      socket.on("connect_error", reject);
      socket.connect();
    });

    sessions.push({ index: i, socket, sessionId: session.id, sentCount: 0 });
  }
  console.log(`All ${SESSION_COUNT} sessions started and joined.\n`);

  console.log(`Sending input for ${DURATION_SECONDS}s...`);
  const intervalMs = 1000 / EVENTS_PER_SECOND;
  const startedAt = performance.now();

  const timers = sessions.map((session) => {
    let x = 0;
    return setInterval(() => {
      x = (x + 137) % 65536; // arbitrary but deterministic movement pattern
      session.socket.emit("hid:input", {
        type: "mouse_move",
        x: x - 32768,
        y: 0,
        ts: performance.now(),
      });
      session.sentCount += 1;
    }, intervalMs);
  });

  await new Promise((resolve) => setTimeout(resolve, DURATION_SECONDS * 1000));
  timers.forEach(clearInterval);
  const elapsedSeconds = (performance.now() - startedAt) / 1000;

  const totalSent = sessions.reduce((sum, s) => sum + s.sentCount, 0);
  console.log(`\nSent ${totalSent} events across ${SESSION_COUNT} sessions in ${elapsedSeconds.toFixed(1)}s`);
  console.log(`Achieved throughput: ${(totalSent / elapsedSeconds).toFixed(1)} events/sec (target: ${SESSION_COUNT * EVENTS_PER_SECOND})`);

  console.log("\nEnding sessions and disconnecting...");
  for (const session of sessions) {
    session.socket.disconnect();
  }
  // Sessions are ended via direct Prisma update, not the REST endpoint: EndSessionHandler's
  // pikvm.release() would otherwise try (and, per the earlier timeout fix, take up to 5s) to
  // reach the deliberately-unreachable PIKVM_HOST for every single session, serially slowing
  // down teardown of a load test whose whole point was already proven by this point.
  await prisma.session.updateMany({
    where: { equipment: { tenantId: tenant.id } },
    data: { status: "ENDED", endedAt: new Date() },
  });

  console.log("\nFetching /metrics for the input-forwarding latency histogram...");
  const metricsText = await (await fetch(`${API_URL}/metrics`)).text();
  const relevant = metricsText
    .split("\n")
    .filter((line) => line.startsWith("crop_hid_forward_duration_seconds") || line.startsWith("crop_hid_input_events_total"));
  console.log(relevant.join("\n"));

  await prisma.$disconnect();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
