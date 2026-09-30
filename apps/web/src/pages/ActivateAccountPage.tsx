import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { InvitationPreview } from "@crop/shared";
import { api } from "../lib/api-client.js";
import { translatePasswordError } from "../lib/password-errors.js";
import { AuthCard } from "../components/AuthCard.js";
import { IdentityCard } from "../components/IdentityCard.js";
import { ExpiryCountdown } from "../components/ExpiryCountdown.js";
import { SetPasswordForm } from "../components/SetPasswordForm.js";
import { Button } from "../components/ui/button.js";

/**
 * The redemption side of the "Enviar Convite Seguro" flow (see AdminUsersPage /
 * SendInvitationHandler) -- replaces what used to be an admin-typed temp password relayed
 * out of band. Same shape as RecoveryPage's reset tab: read-only preview first (never burns
 * the token's single use -- see PreviewInvitationHandler), then the real activation, which
 * does.
 */
export default function ActivateAccountPage() {
  const { t } = useTranslation(["activation"]);
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  return (
    <AuthCard tagline={t("activation:tagline")}>
      {token ? <ActivationForm token={token} /> : <p role="alert">{t("activation:noTokenBody")}</p>}
    </AuthCard>
  );
}

type ActivationState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "valid"; data: InvitationPreview }
  | { kind: "done" };

function ActivationForm({ token }: { token: string }) {
  const { t } = useTranslation(["activation", "password"]);
  const [state, setState] = useState<ActivationState>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    api
      .get<InvitationPreview>(`/auth/invitation?token=${encodeURIComponent(token)}`)
      .then((data) => {
        if (!cancelled) setState({ kind: "valid", data });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "invalid" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === "loading") {
    return <p aria-live="polite">{t("activation:loadingToken")}</p>;
  }

  if (state.kind === "invalid" || state.kind === "expired") {
    return <p role="alert">{state.kind === "expired" ? t("activation:expiredMessage") : t("activation:invalidTokenBody")}</p>;
  }

  if (state.kind === "done") {
    return (
      <div>
        <p role="status" className="mb-4">
          {t("activation:activationSuccess")}
        </p>
        <Button asChild className="w-full">
          <Link to="/login">{t("activation:backToLogin")}</Link>
        </Button>
      </div>
    );
  }

  const { data } = state;

  async function handleSubmit(newPassword: string) {
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/activate", { token, newPassword }, { auth: false });
      setState({ kind: "done" });
    } catch (err) {
      setError(translatePasswordError(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="mt-0 mb-1 text-xl font-semibold">{t("activation:title")}</h2>
      <p className="mt-0 text-muted-foreground">{t("activation:subtitle")}</p>

      <IdentityCard role={data.role} email={data.email} professionalRegistration={data.professionalRegistration} />

      <SetPasswordForm
        personalInfoContext={{ email: data.email, firstName: data.firstName, lastName: data.lastName }}
        onSubmit={handleSubmit}
        busy={busy}
        error={error}
        submitLabel={t("password:save")}
        submitBusyLabel={t("password:saveBusy")}
      />

      <p className="mt-4 text-center text-xs text-muted-foreground">
        {t("activation:expiryLabel")}: <ExpiryCountdown expiresAt={new Date(data.expiresAt)} onExpire={() => setState({ kind: "expired" })} />
      </p>
    </div>
  );
}

