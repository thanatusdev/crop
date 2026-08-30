import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth-context.js";
import { ApiError } from "../lib/api-client.js";

type Step =
  | { name: "credentials" }
  | { name: "mfa"; mfaToken: string }
  | { name: "enroll"; enrollmentToken: string; provisioningUri: string };

export default function LoginPage() {
  const { login, verifyMfa, confirmEnrollment } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>({ name: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleCredentialsSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(email, password);
      if (result.status === "mfa_required") {
        setStep({ name: "mfa", mfaToken: result.mfaToken });
      } else if (result.status === "mfa_enrollment_required") {
        setStep({
          name: "enroll",
          enrollmentToken: result.enrollmentToken,
          provisioningUri: result.provisioningUri,
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleMfaSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (step.name !== "mfa") return;
    setError(null);
    setBusy(true);
    try {
      await verifyMfa(step.mfaToken, code);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  async function handleEnrollSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (step.name !== "enroll") return;
    setError(null);
    setBusy(true);
    try {
      await confirmEnrollment(step.enrollmentToken, code);
      setStep({ name: "credentials" });
      setCode("");
      setError("2FA enrolled. Please log in again.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 420, marginTop: 80 }}>
      <h1>CROP</h1>
      <p style={{ color: "#9aa4b2" }}>Clinical Remote Operation Platform</p>

      <div className="card">
        {step.name === "credentials" && (
          <form onSubmit={handleCredentialsSubmit}>
            <div className="field">
              <label>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <p className="error">{error}</p>}
            <button className="btn" disabled={busy} type="submit">
              {busy ? "Signing in..." : "Sign in"}
            </button>
          </form>
        )}

        {step.name === "mfa" && (
          <form onSubmit={handleMfaSubmit}>
            <p>Enter the 6-digit code from your authenticator app.</p>
            <div className="field">
              <label>Code</label>
              <input
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                required
              />
            </div>
            {error && <p className="error">{error}</p>}
            <button className="btn" disabled={busy} type="submit">
              {busy ? "Verifying..." : "Verify"}
            </button>
          </form>
        )}

        {step.name === "enroll" && (
          <form onSubmit={handleEnrollSubmit}>
            <p>Two-factor authentication is mandatory. Scan this in your authenticator app:</p>
            <p style={{ wordBreak: "break-all", fontFamily: "monospace", fontSize: 12, color: "#9aa4b2" }}>
              {step.provisioningUri}
            </p>
            <div className="field">
              <label>Enter the code it generates to confirm</label>
              <input
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                required
              />
            </div>
            {error && <p className="error">{error}</p>}
            <button className="btn" disabled={busy} type="submit">
              {busy ? "Confirming..." : "Confirm enrollment"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
