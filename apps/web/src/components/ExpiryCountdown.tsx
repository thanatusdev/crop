import { useEffect, useRef, useState } from "react";

/**
 * Ticks down to `expiresAt` and calls `onExpire` exactly once when it's reached. `aria-live`
 * is deliberately `"off"`: a per-second announcement would make this screen unusable with a
 * screen reader. The *transition* into the expired state is still communicated -- see the
 * caller, which swaps this out for a real, `role="alert"` message once `onExpire` fires,
 * rather than expecting anyone to notice a silently-ticking clock reach zero.
 */
export function ExpiryCountdown({ expiresAt, onExpire }: { expiresAt: Date; onExpire: () => void }) {
  const [remainingMs, setRemainingMs] = useState(() => expiresAt.getTime() - Date.now());
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;
    const interval = setInterval(() => {
      const next = expiresAt.getTime() - Date.now();
      setRemainingMs(next);
      // Fired from inside the same tick that crosses zero, guarded by a ref rather than a
      // second effect keyed off remainingMs -- avoids calling onExpire once per re-render if
      // the parent re-renders for any other reason while already expired.
      if (next <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpire();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt, onExpire]);

  const clamped = Math.max(0, remainingMs);
  const minutes = Math.floor(clamped / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);

  return (
    <span aria-live="off" className="font-mono font-bold text-primary">
      {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
    </span>
  );
}
