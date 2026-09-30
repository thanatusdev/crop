import { useEffect, useRef, useState } from "react";

/**
 * A standalone utility page, not part of the authenticated app -- meant to be opened
 * directly on the TARGET machine (the one being remotely controlled via PiKVM), not by an
 * operator. The demo technique: open this on the target, then have the operator's browser
 * (showing the PiKVM console video of that same screen) sit next to it. A single screenshot
 * capturing both the true local time here and the delayed value visible in the video feed
 * is a photographable, unambiguous measurement of the actual end-to-end latency -- no trust
 * required in a self-reported number, which is why this is the standard way KVM vendors
 * (including PiKVM itself) demonstrate latency claims.
 *
 * Deliberately outside the authenticated app shell (see App.tsx): the target machine has no
 * reason to ever hold a RadLink login.
 */
export default function LatencyClockPage() {
  const [now, setNow] = useState(() => new Date());
  const [frame, setFrame] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const tick = () => {
      setNow(new Date());
      setFrame((f) => (f + 1) % 360); // drives the rotating marker below -- a fast, unambiguous motion cue for eyeballing latency live, not just in a screenshot
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      }}
    >
      <div style={{ fontSize: "min(20vw, 220px)", fontWeight: 700, letterSpacing: "0.02em", lineHeight: 1 }}>
        {hh}:{mm}:{ss}
        <span style={{ color: "#5fdc8a" }}>.{ms}</span>
      </div>

      <div
        style={{
          marginTop: 40,
          width: 120,
          height: 120,
          borderRadius: "50%",
          border: "6px solid #262b36",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: 6,
            height: 54,
            background: "#5fdc8a",
            transformOrigin: "top center",
            transform: `translate(-50%, 0) rotate(${frame}deg)`,
          }}
        />
      </div>

      <p style={{ marginTop: 40, color: "#9aa4b2", fontSize: 14, maxWidth: 480, textAlign: "center" }}>
        Open on the machine being remotely controlled. Compare this display against the same
        moment visible in the operator's PiKVM console feed to measure true round-trip latency.
      </p>
    </div>
  );
}
