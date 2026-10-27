import { useEffect, useRef } from "react";
import { useWhepPlayer } from "../hooks/use-whep-player.js";

/**
 * The room camera feed as `ExamPage`'s own full-size left-column panel (via `useWhepPlayer`),
 * shown as its own card because the RadLink cockpit mock shows the room camera as a panel,
 * not a corner inset.
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
