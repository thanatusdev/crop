import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { evaluatePassword, type PasswordEvaluationContext } from "@crop/shared";
import { PasswordField } from "./PasswordField.js";
import { PasswordStrength } from "./PasswordStrength.js";
import { PasswordPolicyChecklist } from "./PasswordPolicyChecklist.js";
import { Button } from "./ui/button.js";
import { Card, CardContent } from "./ui/card.js";
import { Alert, AlertDescription } from "./ui/alert.js";
import { Loader2 } from "lucide-react";

/**
 * The one "choose a new password" form, shared by RecoveryPage's reset tab and
 * ForcePasswordChangePage -- same fields, same live strength meter, same policy checklist,
 * evaluated with the exact function the server enforces
 * (`packages/shared/src/password-policy.ts`), so what this form allows through and what the
 * API accepts can never quietly drift apart into two different rule sets.
 *
 * Submit is disabled until the policy passes AND both fields match -- the mismatch check is
 * purely local (there is no server round trip for "do these two fields agree with each
 * other"), so it's enforced here rather than waited for on a failed submit.
 */
export function SetPasswordForm({
  personalInfoContext,
  onSubmit,
  busy,
  error,
  submitLabel,
  submitBusyLabel,
}: {
  personalInfoContext: PasswordEvaluationContext;
  onSubmit: (newPassword: string) => Promise<void>;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  submitBusyLabel: string;
}) {
  const { t } = useTranslation(["password"]);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [touched, setTouched] = useState(false);

  const evaluation = useMemo(() => evaluatePassword(newPassword, personalInfoContext), [newPassword, personalInfoContext]);
  const mismatch = touched && confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit = evaluation.ok && confirmPassword.length > 0 && newPassword === confirmPassword && !busy;

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    await onSubmit(newPassword);
  }

  return (
    <form onSubmit={handleSubmit}>
      <PasswordField
        id="set-password-new"
        label={t("password:newPasswordLabel")}
        value={newPassword}
        onChange={setNewPassword}
        showLabel={t("password:showPassword")}
        hideLabel={t("password:hidePassword")}
        required
        autoFocus
      />
      <PasswordStrength password={newPassword} evaluation={evaluation} />

      <div className="mt-4">
        <PasswordField
          id="set-password-confirm"
          label={t("password:confirmPasswordLabel")}
          value={confirmPassword}
          onChange={(value) => {
            setConfirmPassword(value);
            setTouched(true);
          }}
          showLabel={t("password:showPassword")}
          hideLabel={t("password:hidePassword")}
          required
        />
      </div>
      {mismatch && (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{t("password:mismatch")}</AlertDescription>
        </Alert>
      )}

      <Card className="mt-4 py-4">
        <CardContent>
          <PasswordPolicyChecklist evaluation={evaluation} />
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={!canSubmit} className="mt-4 w-full">
        {busy && <Loader2 className="animate-spin" />}
        {busy ? submitBusyLabel : submitLabel}
      </Button>
    </form>
  );
}

