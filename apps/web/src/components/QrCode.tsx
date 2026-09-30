import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Renders `value` (the `otpauth://` provisioning URI) as a scannable QR code. Previously
 * this URI was shown as raw monospace text (see git history) -- `qrcode` was already a
 * declared-but-unused dependency on the API side (apps/api/package.json) for exactly this,
 * it just never got wired up on either side until now.
 */
export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { width: size, margin: 1 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (error) return null; // caller already renders the raw URI as a fallback
  if (!dataUrl) return <div style={{ width: size, height: size }} aria-hidden="true" />;

  return <img src={dataUrl} width={size} height={size} alt="" className="rounded-lg bg-white p-2" />;
}

