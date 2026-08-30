import { useEffect, useRef } from "react";
import { useWhepPlayer } from "../hooks/use-whep-player.js";

/**
 * Picture-in-picture room camera feed, rendered only when the equipment has a `cameraUrl`
 * configured (a MediaMTX WHEP endpoint, e.g. `http://host:8889/cctv/whep`). Absent camera
 * config means no PiP, not an error -- the console view works fully without it.
 */
export function CctvPip({ whepUrl }: { whepUrl: string | null }) {
  const { stream, status } = useWhepPlayer(whepUrl);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  if (!whepUrl) return null;

  return (
    <div className="cctv-pip">
      {status === "playing" ? (
        <video ref={videoRef} autoPlay playsInline muted />
      ) : (
        <div className="cctv-pip-status">{status === "error" ? "CCTV unavailable" : "Connecting to room camera..."}</div>
      )}
      <div className="cctv-pip-label">Room camera</div>
    </div>
  );
}
