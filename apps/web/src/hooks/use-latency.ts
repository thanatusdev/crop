import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { RT_EVENTS, type LatencyPong } from "@crop/shared";

const PING_INTERVAL_MS = 1000;

/** Measured input round-trip time: client -> gateway -> client. Rendered in the on-screen HUD. */
export function useLatency(socket: Socket | null): number | null {
  const [rttMs, setRttMs] = useState<number | null>(null);

  useEffect(() => {
    if (!socket) return;

    const onPong = (payload: LatencyPong) => {
      setRttMs(Math.round(performance.now() - payload.clientTs));
    };
    socket.on(RT_EVENTS.LATENCY_PONG, onPong);

    const timer = setInterval(() => {
      socket.emit(RT_EVENTS.LATENCY_PING, { clientTs: performance.now() });
    }, PING_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      socket.off(RT_EVENTS.LATENCY_PONG, onPong);
    };
  }, [socket]);

  return rttMs;
}
