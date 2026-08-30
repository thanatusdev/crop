import { useEffect, useState } from "react";
import { api } from "../lib/api-client.js";

/**
 * Fetches a binary image via an authenticated request (a plain `<img src>` can't attach an
 * Authorization header) and manages the resulting blob: URL's lifetime -- revoked on every
 * path change and on unmount, since object URLs otherwise leak for the life of the tab.
 */
export function useAuthenticatedImage(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }

    let objectUrl: string | null = null;
    let cancelled = false;

    void api.getBlob(path).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return url;
}
