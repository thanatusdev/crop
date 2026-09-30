import { Video } from "lucide-react";

/**
 * The rounded-square video-camera mark from the RadLink login mock. `lucide-react`'s
 * `Video` icon, not a hand-drawn inline SVG -- once the app has an icon library there is no
 * reason to keep hand-tracing the mock's own camera glyph.
 */
export function Logo({ size = 56 }: { size?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-[28%] border bg-card"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Video className="text-primary" style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={1.8} />
    </div>
  );
}

