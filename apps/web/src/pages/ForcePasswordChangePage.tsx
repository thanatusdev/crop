import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth, type VerifyMfaOutcome } from "../lib/auth-context.js";
import { decodeJwtPayload } from "../lib/jwt.js";
import { homeRouteForRole } from "../lib/role-routes.js";
import { translatePasswordError } from "../lib/password-errors.js";
import { AuthCard } from "../components/AuthCard.js";
import { IdentityCard } from "../components/IdentityCard.js";
import { ExpiryCountdown } from "../components/ExpiryCountdown.js";
import { SetPasswordForm } from "../components/SetPasswordForm.js";
import { Button } from "../components/ui/button.js";

type ForcedChangeState = Extract<VerifyMfaOutcome, { status: "password_change_required" }>;

/**
 * Reached only by navigating from LoginPage's MFA step with router state -- never by typing
 * a URL, never by a bookmark, never after a page reload. The `changeToken` is a real bearer
 * credential (see ChangePasswordHandler): both factors were just proven to get it, so it's
 * passed via `navigate(..., { state })`, never a query param (would land in browser history
 * and server access logs) or localStorage (would outlive the 10-minute token and linger for
 * no reason). Losing it on reload is the correct behavior, not a gap to fix -- see the
 * redirect-to-login effect below.
 */
export default function ForcePasswordChangePage() {
  const { t } = useTranslation(["changePassword", "password"]);
  const location = useLocation();
  const navigate = useNavigate();
  const { changePassword } = useAuth();

  const state = location.state as ForcedChangeState | null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!state) navigate("/login", { replace: true });
  }, [state, navigate]);

  // Decoded locally (this app already does this for access tokens -- see lib/jwt.ts) rather
  // than requiring a second server round trip just to learn the token's own `exp`: the
  // change token is unverified here anyway, purely for rendering the countdown, and the
  // server independently and authoritatively re-verifies it on the real submit.
  const expiresAt = useMemo(() => {
    if (!state) return new Date();
    try {
      return new Date(decodeJwtPayload<{ exp: number }>(state.changeToken).exp * 1000);
    } catch {
      return new Date();
    }
  }, [state]);

  if (!state) return null;

  if (expired) {
    return (
      <AuthCard tagline={t("changePassword:tagline")}>
        <p role="alert" className="mb-4">
          {t("changePassword:expiredMessage")}
        </p>
        <Button asChild className="w-full">
          <Link to="/login">{t("changePassword:backToLogin")}</Link>
        </Button>
      </AuthCard>
    );
  }

  async function handleSubmit(newPassword: string) {
    setError(null);
    setBusy(true);
    try {
      const claims = await changePassword(state!.changeToken, newPassword);
      navigate(homeRouteForRole(claims.role), { replace: true });
    } catch (err) {
      setError(translatePasswordError(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard tagline={t("changePassword:tagline")}>
      <h2 className="mt-0 mb-1 text-xl font-semibold">{t("changePassword:title")}</h2>
      <p className="mt-0 text-muted-foreground">
        {state.reason === "must_change" ? t("changePassword:reasonMustChange") : t("changePassword:reasonExpired")}
      </p>

      <IdentityCard role={state.role} email={state.email} professionalRegistration={state.professionalRegistration} />

      <SetPasswordForm
        personalInfoContext={{ email: state.email, firstName: state.firstName, lastName: state.lastName }}
        onSubmit={handleSubmit}
        busy={busy}
        error={error}
        submitLabel={t("password:save")}
        submitBusyLabel={t("password:saveBusy")}
      />

      <p className="mt-4 text-center text-xs text-muted-foreground">
        {t("changePassword:expiryLabel")} <ExpiryCountdown expiresAt={expiresAt} onExpire={() => setExpired(true)} />
      </p>
    </AuthCard>
  );
}

