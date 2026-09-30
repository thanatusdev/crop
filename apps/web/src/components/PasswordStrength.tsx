import { useTranslation } from "react-i18next";
import type { PasswordEvaluation } from "@crop/shared";
import { cn } from "cn";

/**
 * The four-segment meter plus the "Aguardando entrada"/fraca/média/forte badge from the
 * mock. Deliberately scored only against the four context-free rules (length/case/digit/
 * symbol) -- `noPersonalInfo` is a binary pass/fail, not a gradient, so a password that
 * would otherwise be "strong" but contains the account's own name is still shown as strong
 * *and* still blocked from submitting (see SetPasswordForm, which disables its button on
 * `!evaluation.ok` regardless of what this meter says). Folding personal-info into the
 * gradient would make an already-strong-looking password silently lose a segment for a
 * reason this meter has no way to explain.
 */
export function PasswordStrength({ password, evaluation }: { password: string; evaluation: PasswordEvaluation }) {
  const { t } = useTranslation(["password"]);

  const primaryRuleCount = 4; // minLength, mixedCase, digit, symbol
  const satisfiedCount = evaluation.satisfied.filter((rule) => rule !== "noPersonalInfo").length;

  const label =
    password.length === 0
      ? t("password:strengthAwaiting")
      : satisfiedCount <= 2
        ? t("password:strengthWeak")
        : satisfiedCount === 3
          ? t("password:strengthMedium")
          : t("password:strengthStrong");

  return (
    <div className="mt-1.5">
      <div className="flex gap-1" role="presentation">
        {Array.from({ length: primaryRuleCount }, (_, i) => (
          <span key={i} aria-hidden="true" className={cn("h-1 flex-1 rounded-full", i < satisfiedCount ? "bg-primary" : "bg-border")} />
        ))}
      </div>
      {/* aria-live: this badge changes on every keystroke -- polite so a screen-reader user
          hears the updated strength without it interrupting whatever they're doing. */}
      <p aria-live="polite" className="mt-1 text-xs text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

