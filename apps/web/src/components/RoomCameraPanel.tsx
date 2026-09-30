import { useEffect, useRef } from "react";
import { useWhepPlayer } from "../hooks/use-whep-player.js";

/**
 * The room camera feed as `ExamPage`'s own full-size left-column panel -- the same
 * `useWhepPlayer` connection `CctvPip` already established for the console's small
 * picture-in-picture overlay, promoted to a first-class card here because the RadLink cockpit
 * mock shows the room camera as its own panel, not a corner inset, once a dedicated exam
 * screen exists to give it the room. `CctvPip` itself is untouched and keeps doing exactly
 * that smaller job inside `.console-box` on both `SessionPage` and this page's own console
 * mirror -- the two are deliberately not unified into one configurable component, since a
 * "sometimes tiny corner overlay, sometimes full card" prop would be harder to read than two
 * small, honestly-named ones sharing the one hook that actually matters.
 */
export function RoomCameraPanel({ whepUrl }: { whepUrl: string | null }) {
  const { stream, status } = useWhepPlayer(whepUrl);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  return (
    <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
      {!whepUrl ? (
        <div className="flex h-full items-center justify-center p-2 text-center text-sm text-gray-400" role="status">
          Sem câmera configurada para esta sala.
        </div>
      ) : status === "playing" ? (
        <video ref={videoRef} autoPlay playsInline muted className="size-full object-cover" aria-label="Câmera da sala" />
      ) : (
        <div className="flex h-full items-center justify-center p-2 text-center text-sm text-gray-400" role="status">
          {status === "error" ? "Câmera indisponível" : "Conectando à câmera da sala..."}
        </div>
      )}
    </div>
  );
}
