import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldCheck, Lock, Loader2 } from "lucide-react";
import { useAuth } from "../lib/auth-context.js";
import { ApiError } from "../lib/api-client.js";
import { homeRouteForRole } from "../lib/role-routes.js";
import { AuthCard } from "../components/AuthCard.js";
import { PasswordField } from "../components/PasswordField.js";
import { QrCode } from "../components/QrCode.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";

type Step =
  | { name: "credentials" }
  | { name: "mfa"; mfaToken: string }
  | { name: "enroll"; enrollmentToken: string; provisioningUri: string };

export default function LoginPage() {
  const { t } = useTranslation(["auth", "common"]);
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
      setError(err instanceof ApiError ? err.message : t("auth:genericLoginError"));
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
      const outcome = await verifyMfa(step.mfaToken, code);
      if (outcome.status === "password_change_required") {
        // The changeToken is a bearer credential -- passed via router state, never a query
        // param or localStorage (see ForcePasswordChangePage's own docstring for why). State
        // doesn't survive a reload, which is correct here: a token this short-lived (10 min
        // default) sitting in browser history/back-forward cache would be a real, if narrow,
        // exposure for no benefit.
        navigate("/trocar-senha", { replace: true, state: outcome });
        return;
      }
      // Role-based redirect (see role-routes.ts) -- previously every role landed on "/"
      // unconditionally. Reads the just-returned claims, not the `user` from useAuth():
      // this render's `user` is still the pre-login `null`, since verifyMfa's setUser call
      // hasn't committed yet.
      navigate(homeRouteForRole(outcome.claims.role), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth:genericCodeError"));
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
      setError(t("auth:enrolledMessage"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth:genericCodeError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      tagline={t("auth:tagline")}
      footer={
        step.name === "credentials" && (
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="size-3.5" />
            {t("auth:securityFooter")}
          </span>
        )
      }
    >
      {step.name === "credentials" && (
        <form onSubmit={handleCredentialsSubmit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-email">{t("auth:emailLabel")}</Label>
            <Input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div className="mt-4">
            <PasswordField
              id="login-password"
              label={t("auth:passwordLabel")}
              labelExtra={
                <Link to="/recuperar-senha" className="text-sm text-primary hover:underline">
                  {t("auth:forgotPassword")}
                </Link>
              }
              value={password}
              onChange={setPassword}
              showLabel={t("auth:showPassword")}
              hideLabel={t("auth:hidePassword")}
              required
            />
          </div>
          {error && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button disabled={busy} type="submit" className="mt-4 w-full">
            {busy && <Loader2 className="animate-spin" />}
            {busy ? t("auth:submitBusy") : `${t("auth:submit")} →`}
          </Button>
        </form>
      )}

      {step.name === "mfa" && (
        <form onSubmit={handleMfaSubmit}>
          <p className="mb-4">{t("auth:mfaIntro")}</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-mfa-code">{t("auth:codeLabel")}</Label>
            <div className="relative">
              <Input
                id="login-mfa-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                required
                className="pr-10 text-center font-semibold tracking-[4px]"
              />
              <Lock aria-hidden="true" className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>
          {error && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button disabled={busy} type="submit" className="mt-4 w-full">
            {busy && <Loader2 className="animate-spin" />}
            {busy ? t("auth:verifyBusy") : t("auth:verify")}
          </Button>
        </form>
      )}

      {step.name === "enroll" && (
        <form onSubmit={handleEnrollSubmit}>
          <p className="mb-4">{t("auth:enrollIntro")}</p>
          <div className="my-3 flex justify-center">
            <QrCode value={step.provisioningUri} />
          </div>
          <p className="mb-0.5 text-xs text-muted-foreground">{t("auth:enrollUriFallback")}</p>
          <p className="break-all font-mono text-xs text-muted-foreground">{step.provisioningUri}</p>
          <div className="mt-4 flex flex-col gap-1.5">
            <Label htmlFor="login-enroll-code">{t("auth:enrollCodeLabel")}</Label>
            <Input
              id="login-enroll-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              required
            />
          </div>
          {error && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button disabled={busy} type="submit" className="mt-4 w-full">
            {busy && <Loader2 className="animate-spin" />}
            {busy ? t("auth:confirmBusy") : t("auth:confirm")}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}

