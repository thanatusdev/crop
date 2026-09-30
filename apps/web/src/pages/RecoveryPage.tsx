import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { PasswordResetValidateResponse } from "@crop/shared";
import { Loader2 } from "lucide-react";
import { api, ApiError } from "../lib/api-client.js";
import { translatePasswordError } from "../lib/password-errors.js";
import { AuthCard } from "../components/AuthCard.js";
import { Modal } from "../components/Modal.js";
import { Stepper } from "../components/Stepper.js";
import { IdentityCard } from "../components/IdentityCard.js";
import { ExpiryCountdown } from "../components/ExpiryCountdown.js";
import { SetPasswordForm } from "../components/SetPasswordForm.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";

type Tab = "request" | "reset";

/**
 * Reverses the previous, static "no self-service reset" version of this page (see
 * docs/architecture.md for why that decision reversed once a mailer existed). Two tabs,
 * matching the RadLink mock: "Solicitar Token" requests a reset link by email; "Nova Senha"
 * redeems one. The emailed link points at `?token=...` on this same route, so landing here
 * with that param auto-selects "Nova Senha" and goes straight to the identity-card +
 * new-password screen -- no token field, matching the richer mock this page was rebuilt
 * against. Arriving with no token instead shows a minimal "paste it by hand" fallback (see
 * `TokenPasteForm`), for when an email client mangles the link's query string.
 *
 * The tab strip is shadcn's `Tabs` (Radix) -- arrow-key roving focus, `aria-selected`, and
 * `role="tab"`/`"tabpanel"` wiring all come from the primitive now, replacing a hand-rolled
 * `Tab` button that reimplemented the same ARIA pattern by hand.
 */
export default function RecoveryPage() {
  const { t } = useTranslation(["recovery"]);
  const [searchParams] = useSearchParams();
  const tokenFromLink = searchParams.get("token");

  const [activeTab, setActiveTab] = useState<Tab>(tokenFromLink ? "reset" : "request");

  return (
    <AuthCard tagline={t("recovery:tagline")}>
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as Tab)}>
        <TabsList className="mb-4 w-full">
          <TabsTrigger value="request">{t("recovery:tabRequest")}</TabsTrigger>
          <TabsTrigger value="reset">{t("recovery:tabReset")}</TabsTrigger>
        </TabsList>

        <TabsContent value="request">
          <RequestTab />
        </TabsContent>
        <TabsContent value="reset">
          <ResetTab initialToken={tokenFromLink} />
        </TabsContent>
      </Tabs>

      <p className="mt-4">
        <Link to="/login" className="text-sm text-primary hover:underline">
          {t("recovery:backToLogin")}
        </Link>
      </p>
    </AuthCard>
  );
}

function RequestTab() {
  const { t } = useTranslation(["recovery"]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // Captured synchronously in the click/submit handler, before `setBusy(true)` disables the
  // button below -- see Modal's own `returnFocusTo` docstring on why that ordering matters:
  // disabling the currently-focused element blurs it to `<body>` immediately, before the
  // modal even mounts to capture it itself.
  const triggerRef = useRef<HTMLElement | null>(null);

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    triggerRef.current = document.activeElement as HTMLElement | null;
    setError(null);
    setBusy(true);
    try {
      // Always succeeds from the caller's point of view -- see
      // RequestPasswordResetHandler's docstring on why the response can't distinguish a
      // real account from a nonexistent one.
      await api.post("/auth/password-reset/request", { email }, { auth: false });
      setSentTo(email);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("recovery:genericRequestError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-4">{t("recovery:requestBody")}</p>
      <form onSubmit={handleSubmit}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="recovery-email">{t("recovery:emailLabel")}</Label>
          <Input id="recovery-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </div>
        {error && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button disabled={busy} type="submit" className="mt-4 w-full">
          {busy && <Loader2 className="animate-spin" />}
          {busy ? t("recovery:sendBusy") : t("recovery:send")}
        </Button>
      </form>

      {sentTo && (
        <Modal title={t("recovery:modalTitle")} onClose={() => setSentTo(null)} returnFocusTo={triggerRef.current}>
          <Badge variant="secondary" className="mb-2.5">
            {t("recovery:modalBadge")}
          </Badge>
          <p>{t("recovery:modalBody")}</p>
          <p className="rounded-md bg-secondary p-2.5 font-mono break-all">{sentTo}</p>
          <p className="text-sm text-muted-foreground">{t("recovery:modalInfo", { minutes: 15 })}</p>
          <Button type="button" onClick={() => setSentTo(null)} className="mt-2 w-full">
            {t("recovery:modalOk")} ✓
          </Button>
          <p className="mt-3 text-center">
            <Link to="/login" className="text-sm text-primary hover:underline">
              ← {t("recovery:backToLogin")}
            </Link>
          </p>
        </Modal>
      )}
    </div>
  );
}

function ResetTab({ initialToken }: { initialToken: string | null }) {
  const navigate = useNavigate();

  return initialToken ? (
    <ValidatedResetForm token={initialToken} />
  ) : (
    <TokenPasteForm onSubmit={(token) => navigate(`/recuperar-senha?token=${encodeURIComponent(token)}`)} />
  );
}

function TokenPasteForm({ onSubmit }: { onSubmit: (token: string) => void }) {
  const { t } = useTranslation(["recovery"]);
  const [token, setToken] = useState("");

  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        if (token.trim()) onSubmit(token.trim());
      }}
    >
      <p className="mb-4">{t("recovery:pasteTokenIntro")}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recovery-paste-token">{t("recovery:tokenLabel")}</Label>
        <Input id="recovery-paste-token" value={token} onChange={(e) => setToken(e.target.value)} required autoFocus />
      </div>
      <Button type="submit" className="mt-4 w-full">
        {t("recovery:continueLabel")}
      </Button>
    </form>
  );
}

type ValidationState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "valid"; data: PasswordResetValidateResponse }
  | { kind: "done" };

/** Maps the two policy error codes the API can return to translated copy; anything else
 * (a real network failure, an unrecognized code) falls back to a generic message rather
 * than surfacing English server text on this pt-BR page. */

function ValidatedResetForm({ token }: { token: string }) {
  const { t } = useTranslation(["recovery", "password"]);
  const [state, setState] = useState<ValidationState>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    api
      .get<PasswordResetValidateResponse>(`/auth/password-reset/validate?token=${encodeURIComponent(token)}`)
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
    return <p aria-live="polite">{t("recovery:loadingToken")}</p>;
  }

  if (state.kind === "invalid" || state.kind === "expired") {
    return (
      <div>
        <p role="alert" className="mb-4">
          {state.kind === "expired" ? t("recovery:expiredMessage") : t("recovery:invalidTokenBody")}
        </p>
        <Button asChild className="w-full">
          <Link to="/recuperar-senha">{t("recovery:requestNewLink")}</Link>
        </Button>
      </div>
    );
  }

  if (state.kind === "done") {
    return (
      <div>
        <p role="status" className="mb-4">
          {t("recovery:resetSuccess")}
        </p>
        <Button asChild className="w-full">
          <Link to="/login">{t("recovery:backToLogin")}</Link>
        </Button>
      </div>
    );
  }

  const { data } = state;

  async function handleSubmit(newPassword: string) {
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/password-reset/confirm", { token, newPassword }, { auth: false });
      setState({ kind: "done" });
    } catch (err) {
      setError(translatePasswordError(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Stepper
        steps={[
          { label: t("recovery:stepRequest"), status: "complete" },
          { label: t("recovery:stepReset"), status: "active" },
        ]}
      />
      <h2 className="mt-0 mb-1 text-xl font-semibold">{t("recovery:resetTitle")}</h2>
      <p className="mt-0 text-muted-foreground">{t("recovery:resetSubtitle")}</p>

      <IdentityCard role={data.role} email={data.email} professionalRegistration={data.professionalRegistration} />

      <SetPasswordForm
        personalInfoContext={{ email: data.email, firstName: data.firstName, lastName: data.lastName }}
        onSubmit={handleSubmit}
        busy={busy}
        error={error}
        submitLabel={t("password:save")}
        submitBusyLabel={t("password:saveBusy")}
      />

      <p className="mt-4 mb-1 text-center text-xs text-muted-foreground">
        {t("recovery:expiryLabel")}: <ExpiryCountdown expiresAt={new Date(data.expiresAt)} onExpire={() => setState({ kind: "expired" })} />
      </p>
      <p className="text-center text-xs text-muted-foreground">
        {t("recovery:supportNote")} <strong>{t("recovery:supportContact")}</strong>
      </p>
    </div>
  );
}

