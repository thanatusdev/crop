import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AuditLogEntryDto, VerifyChainResultDto } from "@crop/shared";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "cn";
import { api } from "../lib/api-client.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";

export default function AuditPage() {
  const navigate = useNavigate();
  const [logs, setLogs] = useState<AuditLogEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyChainResultDto | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      setLogs(await api.get<AuditLogEntryDto[]>("/audit?limit=200"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the audit log.");
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
      setVerifyError(err instanceof Error ? err.message : "Could not verify the hash chain.");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b bg-card px-6 py-4">
        <strong>Audit log</strong>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Back to dashboard
        </Button>
      </header>

      <main className="mx-auto max-w-[960px] px-5 py-8">
        <h1 className="mt-0 mb-4 text-xl font-semibold">Audit log</h1>
        <Card className="mb-4">
          <CardContent>
            <Button onClick={verify} disabled={verifying}>
              {verifying && <Loader2 className="animate-spin" />}
              {verifying ? "Verifying chain..." : "Verify hash chain"}
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
                  ? `PASS — ${verifyResult.checkedRows} rows verified, chain intact.`
                  : `FAIL — tampering detected at sequence #${verifyResult.brokenAtSeq}.`}
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
                    Retry
                  </button>
                </AlertDescription>
              </Alert>
            ) : loading ? (
              <p aria-live="polite">Loading...</p>
            ) : (
              <Table>
                <TableCaption className="sr-only">Audit log entries, most recent first</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Seq</TableHead>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Resource</TableHead>
                    <TableHead>Session</TableHead>
                    <TableHead>Hash</TableHead>
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

