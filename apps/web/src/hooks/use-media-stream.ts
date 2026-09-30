import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api-client.js";
import { WS_URL } from "../lib/config.js";

export type StreamStatus = "idle" | "connecting" | "active" | "error";

interface MediaStreamState {
  status: StreamStatus;
  info: string;
}

const PING_INTERVAL_MS = 1000;
const MAX_MISSED_HEARTBEATS = 5;
const RECONNECT_DELAY_MS = 1000;

/**
 * Re-implements PiKVM's own `stream_media.js` client (see docs/pikvm-integration.md) against
 * our `/stream` relay instead of PiKVM directly. The wire protocol is byte-for-byte
 * identical because MediaStreamServer is a pure relay -- this hook is deliberately not
 * "inspired by" PiKVM's client, it *is* the same protocol, so the two can never drift apart
 * by accident.
 *
 * `sessionId: null` means there is no session to mirror yet -- `ExamPage` renders this before
 * any exam has started, and before this hook accepted null it had no way to express "not
 * connecting, nothing failed, simply nothing to show" at all; every render had to either fake
 * a status or start a connection against an id that didn't exist. `"idle"` is that fourth,
 * honest state, distinct from `"error"` (a real failure) and `"connecting"` (a request in
 * flight) -- `ExamPage`'s mirror renders "SEM SINAL" only for the latter two, never for idle.
 */
export function useMediaStream(sessionId: string | null, canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const [state, setState] = useState<MediaStreamState>({ status: "idle", info: "" });
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!sessionId) {
      setState({ status: "idle", info: "" });
      return;
    }

    stoppedRef.current = false;
    let ws: WebSocket | null = null;
    let decoder: VideoDecoder | null = null;
    let codec = "";
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let missedHeartbeats = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const closeDecoder = () => {
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = null;
      codec = "";
    };

    const drawFrame = (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        frame.close();
        return;
      }
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(frame, 0, 0);
      frame.close();
    };

    const ensureDecoder = async (isKeyFrame: boolean): Promise<boolean> => {
      if (!codec) return false;
      if (!decoder || decoder.state === "closed") {
        decoder = new VideoDecoder({
          output: drawFrame,
          error: (err) => setState({ status: "error", info: err.message }),
        });
      }
      if (decoder.state !== "configured") {
        if (!isKeyFrame) return false;
        decoder.configure({ codec, optimizeForLatency: true });
      }
      return decoder.state === "configured";
    };

    const handleBinary = async (data: ArrayBuffer) => {
      const header = new Uint8Array(data.slice(0, 2));
      if (header[0] === 255) {
        missedHeartbeats = 0;
        return;
      }
      if (header[0] !== 1) return;

      const isKeyFrame = !!header[1];
      if (!(await ensureDecoder(isKeyFrame))) return;

      const chunk = new EncodedVideoChunk({
        type: isKeyFrame ? "key" : "delta",
        timestamp: performance.now() * 1000,
        data: data.slice(2),
      });
      decoder!.decode(chunk);
      setState((s) => (s.status === "active" ? s : { status: "active", info: "" }));
    };

    const setupCodec = (formats: { h264?: { profile_level_id: string } }) => {
      closeDecoder();
      if (!formats.h264) {
        setState({ status: "error", info: "No H.264 stream available on PiKVM" });
        return;
      }
      if (!("VideoDecoder" in window)) {
        setState({ status: "error", info: "This browser cannot decode H.264 (needs WebCodecs)" });
        return;
      }
      codec = `avc1.${formats.h264.profile_level_id}`;
      ws?.send(JSON.stringify({ event_type: "start", event: { type: "video", format: "h264" } }));
    };

    const connect = async () => {
      setState((s) => (s.status === "active" ? s : { status: "connecting", info: "" }));

      // The real bug this fixes: a failing ticket request (no active session yet, this
      // caller isn't a participant, the session already ended) used to be an unhandled
      // promise rejection -- `void connect()` below never awaited or caught it -- leaving
      // the hook stuck reporting "connecting" forever, with no error anywhere to explain why.
      // `ExamPage` hits this constantly (rendered before any session exists), which is what
      // surfaced it: distinguishing *idle* / *connecting* / *SEM SINAL* requires this path to
      // actually reach "error" instead of hanging.
      let ticket: string;
      try {
        ticket = (await api.post<{ ticket: string }>(`/sessions/${sessionId}/stream-ticket`)).ticket;
      } catch (err) {
        if (stoppedRef.current) return;
        setState({ status: "error", info: err instanceof Error ? err.message : "Could not obtain a stream ticket" });
        reconnectTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
        return;
      }

      const socket = new WebSocket(`${WS_URL}/stream?ticket=${encodeURIComponent(ticket)}`);
      socket.binaryType = "arraybuffer";
      ws = socket;

      socket.onopen = () => {
        missedHeartbeats = 0;
        pingTimer = setInterval(() => {
          missedHeartbeats += 1;
          if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
            socket.close();
            return;
          }
          socket.send(new Uint8Array([0]));
        }, PING_INTERVAL_MS);
      };

      socket.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          const parsed = JSON.parse(ev.data);
          if (parsed.event_type === "media") setupCodec(parsed.event.video);
        } else {
          void handleBinary(ev.data as ArrayBuffer);
        }
      };

      socket.onerror = () => setState({ status: "error", info: "Stream connection error" });

      socket.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        closeDecoder();
        ws = null;
        if (!stoppedRef.current) {
          reconnectTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
        }
      };
    };

    void connect();

    return () => {
      stoppedRef.current = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      closeDecoder();
      ws?.close();
    };
  }, [sessionId, canvasRef]);

  return state;
}
