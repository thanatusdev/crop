import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AuditLogEntryDto, VerifyChainResultDto } from "@crop/shared";
import { api } from "../lib/api-client.js";

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
    <div>
      <header className="topbar">
        <strong>Audit log</strong>
        <button className="btn secondary" onClick={() => navigate("/")}>
          Back to dashboard
        </button>
      </header>

      <main className="page">
        <h1>Audit log</h1>
        <div className="card">
          <button className="btn" onClick={verify} disabled={verifying}>
            {verifying ? "Verifying chain..." : "Verify hash chain"}
          </button>
          {verifyError && (
            <p className="error" role="alert" style={{ marginTop: 10 }}>
              {verifyError}
            </p>
          )}
          {verifyResult && (
            <p role="status" style={{ marginTop: 10, fontWeight: 600, color: verifyResult.valid ? "#5fdc8a" : "#ff6b6b" }}>
              {verifyResult.valid
                ? `PASS — ${verifyResult.checkedRows} rows verified, chain intact.`
                : `FAIL — tampering detected at sequence #${verifyResult.brokenAtSeq}.`}
            </p>
          )}
        </div>

        <div className="card">
          {loadError ? (
            <p className="error" role="alert">
              {loadError}{" "}
              <button className="link-button" onClick={() => void load()}>
                Retry
              </button>
            </p>
          ) : loading ? (
            <p aria-live="polite">Loading...</p>
          ) : (
            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">Audit log entries, most recent first</caption>
                <thead>
                  <tr>
                    <th scope="col">Seq</th>
                    <th scope="col">Timestamp</th>
                    <th scope="col">Action</th>
                    <th scope="col">Resource</th>
                    <th scope="col">Session</th>
                    <th scope="col">Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id}>
                      <td>{log.seq}</td>
                      <td>{new Date(log.timestamp).toLocaleString()}</td>
                      <td>{log.action}</td>
                      <td>
                        {log.resourceType}
                        {log.resourceId ? ` #${log.resourceId.slice(0, 8)}` : ""}
                      </td>
                      <td>
                        {log.sessionId ? (
                          <button className="link-button" onClick={() => navigate(`/sessions/${log.sessionId}/replay`)}>
                            {log.sessionId.slice(0, 8)}
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={{ fontFamily: "monospace", fontSize: 11 }}>{log.hash.slice(0, 12)}...</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
