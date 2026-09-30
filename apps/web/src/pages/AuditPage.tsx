import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AuditLogEntryDto, VerifyChainResultDto } from "@crop/shared";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "cn";
import { api } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";

export default function AuditPage() {
  const navigate = useNavigate();
  const { t } = useTranslation(["audit"]);
  const { user } = useAuth();
  const [logs, setLogs] = useState<AuditLogEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyChainResultDto | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  useEffect(() => {
    // `/audit` is scoped to the caller's *active* tenant server-side -- same reasoning as
    // ConsoleShell's own fix for the multi-clinic-Manager staleness bug.
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenantId]);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      setLogs(await api.get<AuditLogEntryDto[]>("/audit?limit=200"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("audit:loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    setVerifying(true);
    setVerifyError(null);
    setVerifyResult(null);
    try {
      const result = await api.get<VerifyChainResultDto>("/audit/verify");
      setVerifyResult(result);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : t("audit:verifyError"));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b bg-card px-6 py-4">
        <strong>{t("audit:heading")}</strong>
        <Button variant="secondary" onClick={() => navigate("/")}>
          {t("audit:backToDashboard")}
        </Button>
      </header>

      <main className="mx-auto max-w-[960px] px-5 py-8">
        <h1 className="mt-0 mb-4 text-xl font-semibold">{t("audit:heading")}</h1>
        <Card className="mb-4">
          <CardContent>
            <Button onClick={verify} disabled={verifying}>
              {verifying && <Loader2 className="animate-spin" />}
              {verifying ? t("audit:verifying") : t("audit:verifyChain")}
            </Button>
            {verifyError && (
              <Alert variant="destructive" className="mt-2.5">
                <AlertDescription>{verifyError}</AlertDescription>
              </Alert>
            )}
            {verifyResult && (
              <p role="status" className={cn("mt-2.5 flex items-center gap-1.5 font-semibold", verifyResult.valid ? "text-[#166534]" : "text-destructive")}>
                {verifyResult.valid ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                {verifyResult.valid
                  ? t("audit:verifyPass", { count: verifyResult.checkedRows })
                  : t("audit:verifyFail", { seq: verifyResult.brokenAtSeq ?? "?" })}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            {loadError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {loadError}{" "}
                  <button className="underline" onClick={() => void load()}>
                    {t("audit:retry")}
                  </button>
                </AlertDescription>
              </Alert>
            ) : loading ? (
              <p aria-live="polite">{t("audit:loading")}</p>
            ) : (
              <Table>
                <TableCaption className="sr-only">{t("audit:tableCaption")}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("audit:colSeq")}</TableHead>
                    <TableHead>{t("audit:colTimestamp")}</TableHead>
                    <TableHead>{t("audit:colAction")}</TableHead>
                    <TableHead>{t("audit:colResource")}</TableHead>
                    <TableHead>{t("audit:colSession")}</TableHead>
                    <TableHead>{t("audit:colHash")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell>{log.seq}</TableCell>
                      <TableCell>{new Date(log.timestamp).toLocaleString()}</TableCell>
                      <TableCell>{log.action}</TableCell>
                      <TableCell>
                        {log.resourceType}
                        {log.resourceId ? ` #${log.resourceId.slice(0, 8)}` : ""}
                      </TableCell>
                      <TableCell>
                        {log.sessionId ? (
                          <button className="text-primary underline" onClick={() => navigate(`/sessions/${log.sessionId}/replay`)}>
                            {log.sessionId.slice(0, 8)}
                          </button>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{log.hash.slice(0, 12)}...</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

