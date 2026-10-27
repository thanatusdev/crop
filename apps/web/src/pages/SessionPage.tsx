import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import type { SessionState } from "@crop/shared";
import { api } from "../lib/api-client.js";
import { Button } from "../components/ui/button.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";

/**
 * Legacy `/sessions/:sessionId` entry point, kept only so old links and bookmarks still land
 * somewhere. Supervisors used to get a separate, chat-less console here; they now share
 * `ExamPage` with the operator (same layout, same equipment-scoped room chat), so this just
 * resolves the session's equipment and redirects to `/exame?equipmentId=`.
 */
export default function SessionPage() {
  const { t } = useTranslation(["exam"]);
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    api
      .get<SessionState>(`/sessions/${sessionId}`)
      .then((session) => {
        if (!cancelled) navigate(`/exame?equipmentId=${session.equipmentId}`, { replace: true });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : t("exam:sessionLoadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, navigate, t]);

  if (loadError) {
    return (
      <main className="flex min-h-screen flex-col items-start gap-3 bg-background p-5 text-foreground">
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <Button variant="secondary" onClick={() => navigate("/")}>
          {t("exam:backHome")}
        </Button>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background p-5 text-foreground" aria-live="polite">
      {t("exam:loading")}
    </main>
  );
}
