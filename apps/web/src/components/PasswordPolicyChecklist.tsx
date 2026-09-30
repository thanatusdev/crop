import { useTranslation } from "react-i18next";
import type { PasswordEvaluation, PasswordRuleId } from "@crop/shared";
import { Circle, CircleCheck } from "lucide-react";
import { cn } from "cn";
import { Badge } from "./ui/badge.js";

const RULE_ORDER: PasswordRuleId[] = ["minLength", "mixedCase", "digit", "symbol", "noPersonalInfo"];

/**
 * The mock draws these as radio circles, but they are status OUTPUT (did this password just
 * satisfy the rule, yes or no), never input a user selects -- so this is built as a plain
 * list, not `role="radio"`/`radiogroup`. Rendering it as radios would tell a screen-reader
 * user they can select one one rule as "the" answer, which is nonsensical here and would be
 * a real accessibility regression, not just a technicality.
 */
export function PasswordPolicyChecklist({ evaluation }: { evaluation: PasswordEvaluation }) {
  const { t } = useTranslation(["password"]);

  const ruleCopy: Record<PasswordRuleId, string> = {
    minLength: t("password:ruleMinLength"),
    mixedCase: t("password:ruleMixedCase"),
    digit: t("password:ruleDigit"),
    symbol: t("password:ruleSymbol"),
    noPersonalInfo: t("password:ruleNoPersonalInfo"),
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs font-bold tracking-wide text-muted-foreground">
        <span>{t("password:policyBadgeTitle").toUpperCase()}</span>
        <Badge variant="secondary">{t("password:policyBadgeLevel")}</Badge>
      </div>
      {/* aria-live: re-evaluated on every keystroke, so a screen-reader user hears which
          rules just became satisfied without needing to re-scan the whole list by hand. */}
      <ul className="grid grid-cols-2 gap-1.5 list-none p-0 m-0" aria-live="polite">
        {RULE_ORDER.map((rule) => {
          const satisfied = evaluation.satisfied.includes(rule);
          return (
            <li key={rule} className="flex items-start gap-1.5 text-xs">
              <span aria-hidden="true" className={cn("flex-shrink-0", satisfied ? "text-primary" : "text-muted-foreground")}>
                {satisfied ? <CircleCheck className="size-3.5" /> : <Circle className="size-3.5" />}
              </span>
              <span className={satisfied ? "text-foreground" : "text-muted-foreground"}>
                {ruleCopy[rule]}
                <span className="sr-only">
                  {" "}
                  ({satisfied ? t("password:ruleSatisfied") : t("password:ruleNotSatisfied")})
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

