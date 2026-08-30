import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AuditLogEntryDto, VerifyChainResultDto } from "@crop/shared";
import { api } from "../lib/api-client.js";

export default function AuditPage() {
  const navigate = useNavigate();
  const [logs, setLogs] = useState<AuditLogEntryDto[]>([]);
  const [verifyResult, setVerifyResult] = useState<VerifyChainResultDto | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    void api.get<AuditLogEntryDto[]>("/audit?limit=200").then(setLogs);
  }, []);

  async function verify() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const result = await api.get<VerifyChainResultDto>("/audit/verify");
      setVerifyResult(result);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div>
      <div className="topbar">
        <strong>Audit log</strong>
        <button className="btn secondary" onClick={() => navigate("/")}>
          Back to dashboard
        </button>
      </div>

      <div className="page">
        <div className="card">
          <button className="btn" onClick={verify} disabled={verifying}>
            {verifying ? "Verifying chain..." : "Verify hash chain"}
          </button>
          {verifyResult && (
            <p style={{ marginTop: 10, fontWeight: 600, color: verifyResult.valid ? "#5fdc8a" : "#ff6b6b" }}>
              {verifyResult.valid
                ? `PASS — ${verifyResult.checkedRows} rows verified, chain intact.`
                : `FAIL — tampering detected at sequence #${verifyResult.brokenAtSeq}.`}
            </p>
          )}
        </div>

        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Seq</th>
                <th>Timestamp</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Session</th>
                <th>Hash</th>
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
                      <a href="#" onClick={(e) => { e.preventDefault(); navigate(`/sessions/${log.sessionId}/replay`); }}>
                        {log.sessionId.slice(0, 8)}
                      </a>
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
      </div>
    </div>
  );
}
