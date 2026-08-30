/**
 * A minimal protocol-conformance test double for PiKVM's REST + WebSocket API -- NOT a
 * full simulator (that idea was explicitly rejected in favor of testing against real
 * hardware; see the conversation history). Its only job is to let `pikvm-spike.ts` and
 * `@crop/pikvm`'s client code be exercised over a real TCP/WebSocket connection during
 * development, so a mistake in connection handling, message framing, or reconnect logic is
 * caught here -- independent of whether real PiKVM hardware is reachable from wherever this
 * is run.
 *
 * Passing against this mock proves the *client* code is internally consistent with the
 * protocol as documented and read from PiKVM's own source. It does NOT prove real PiKVM
 * hardware behaves identically -- only `pikvm-spike.ts` run against a real device proves
 * that. Both are meant to be run; neither replaces the other.
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.MOCK_PIKVM_PORT ?? 8443);

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://internal");

  if (url.pathname === "/api/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        result: {
          hid: { online: true, keyboard: { online: true, leds: { caps: false, num: false, scroll: false } }, mouse: { online: true, absolute: true } },
          hw: { health: { temp: { cpu: 42.0 } } },
        },
      })
    );
    return;
  }

  if (url.pathname === "/api/hid/reset" || url.pathname === "/api/hid/print") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: {} }));
    return;
  }

  if (url.pathname === "/api/streamer/snapshot") {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // shortest possible (empty) valid JPEG markers
    return;
  }

  res.writeHead(404).end();
});

const hidWss = new WebSocketServer({ noServer: true });
const mediaWss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://internal");
  if (url.pathname === "/api/ws") {
    hidWss.handleUpgrade(req, socket, head, (ws) => hidWss.emit("connection", ws, req));
  } else if (url.pathname === "/api/media/ws") {
    mediaWss.handleUpgrade(req, socket, head, (ws) => mediaWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

hidWss.on("connection", (ws) => {
  console.log("[mock-pikvm] HID socket connected");

  // Mirrors the exact bundle-of-states-then-loop sequence real PiKVM sends on connect.
  ws.send(
    JSON.stringify({
      event_type: "hid_state",
      event: { online: true, keyboard: { online: true, leds: { caps: false, num: false, scroll: false } }, mouse: { online: true, absolute: true } },
    })
  );
  ws.send(JSON.stringify({ event_type: "loop", event: {} }));

  ws.on("message", (data) => {
    let parsed: { event_type?: string; event?: unknown };
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      console.log("[mock-pikvm] HID: non-JSON message ignored");
      return;
    }
    console.log(`[mock-pikvm] HID received: ${parsed.event_type} ${JSON.stringify(parsed.event)}`);
  });

  ws.on("close", () => console.log("[mock-pikvm] HID socket closed"));
});

mediaWss.on("connection", (ws) => {
  console.log("[mock-pikvm] Media socket connected");
  let started = false;
  let frameTimer: ReturnType<typeof setInterval> | null = null;

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = data as Buffer;
      if (buf.length === 1 && buf[0] === 0) {
        ws.send(Buffer.from([255])); // pong
      }
      return;
    }

    const parsed = JSON.parse(data.toString());
    if (parsed.event_type === "start" && !started) {
      started = true;
      console.log("[mock-pikvm] Media: start received, sending fake frames");
      let seq = 0;
      frameTimer = setInterval(() => {
        // Not real H.264 -- see the docstring above. Enough to validate PiKvmMediaRelay's
        // pure byte-relay behaviour and the spike's header-parsing logic, nothing more.
        const isKeyFrame = seq % 30 === 0;
        const payload = Buffer.from(`fake-frame-${seq}`);
        const frame = Buffer.concat([Buffer.from([1, isKeyFrame ? 1 : 0]), payload]);
        ws.send(frame);
        seq += 1;
      }, 33); // ~30fps
    }
  });

  // Sent immediately, matching real PiKVM's unsolicited "media" event announcing the codec.
  ws.send(JSON.stringify({ event_type: "media", event: { video: { h264: { profile_level_id: "420028" } } } }));

  ws.on("close", () => {
    console.log("[mock-pikvm] Media socket closed");
    if (frameTimer) clearInterval(frameTimer);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[mock-pikvm] Listening on http://localhost:${PORT} (plain HTTP, not HTTPS -- fine for this test double)`);
});
