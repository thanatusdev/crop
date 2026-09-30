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
    // `pointer-events-none`: this floats in the corner of `SessionPage`/`ExamPage`'s own
    // console box, directly on top of the interactive canvas -- without it, a real click
    // landing in this corner would hit the PiP instead of reaching `useHidInput`'s own
    // canvas listeners (the same latent issue the console's `.hud`-equivalent overlays had,
    // fixed alongside this one; see docs/architecture.md's shadcn migration entries).
    <div className="pointer-events-none absolute right-2 bottom-2 aspect-video w-40 overflow-hidden rounded-md border border-white/20 bg-black">
      {status === "playing" ? (
        <video ref={videoRef} autoPlay playsInline muted className="size-full object-cover" aria-label="Room camera feed" />
      ) : (
        <div className="flex h-full items-center justify-center p-1 text-center text-[10px] text-gray-400" role="status">
          {status === "error" ? "CCTV unavailable" : "Connecting to room camera..."}
        </div>
      )}
      <div className="absolute top-0.5 left-1 text-[10px] text-gray-200 [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">Room camera</div>
    </div>
  );
}
