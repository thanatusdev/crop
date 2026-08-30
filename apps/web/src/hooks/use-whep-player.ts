import { useEffect, useState } from "react";

export type WhepStatus = "idle" | "connecting" | "playing" | "error";

/**
 * A minimal WHEP (WebRTC-HTTP Egress Protocol) client for playing MediaMTX's CCTV room feed.
 * No external signaling library needed -- WHEP is just a plain HTTP POST carrying an SDP
 * offer and returning an SDP answer, layered on top of a standard `RTCPeerConnection`.
 *
 * This is intentionally a separate, independent video path from the PiKVM console stream
 * (see docs/architecture.md): different transport (WebRTC vs raw WebSocket), different
 * latency tolerance (1-2s is fine here), and it must never share code or infrastructure with
 * the console path, which cannot tolerate either the added latency or the added failure mode.
 */
export function useWhepPlayer(whepUrl: string | null): { stream: MediaStream | null; status: WhepStatus } {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<WhepStatus>("idle");

  useEffect(() => {
    if (!whepUrl) {
      setStatus("idle");
      return;
    }

    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let resourceUrl: string | null = null;

    const connect = async () => {
      setStatus("connecting");
      pc = new RTCPeerConnection();
      pc.addTransceiver("video", { direction: "recvonly" });

      pc.ontrack = (ev) => {
        if (!cancelled) {
          setStream(ev.streams[0] ?? null);
          setStatus("playing");
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pc?.iceConnectionState === "failed" && !cancelled) setStatus("error");
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const res = await fetch(whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!res.ok) throw new Error(`WHEP offer rejected: HTTP ${res.status}`);

      resourceUrl = res.headers.get("Location");
      const answerSdp = await res.text();
      if (cancelled) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    };

    connect().catch(() => {
      if (!cancelled) setStatus("error");
    });

    return () => {
      cancelled = true;
      pc?.close();
      // Best-effort WHEP session teardown so MediaMTX frees the resource immediately rather
      // than waiting for its own idle timeout -- not required for correctness on our side.
      if (resourceUrl) fetch(resourceUrl, { method: "DELETE" }).catch(() => {});
      setStream(null);
    };
  }, [whepUrl]);

  return { stream, status };
}
