import { useTranslation } from "react-i18next";
import type { UserRole } from "@crop/shared";
import { UserRound } from "lucide-react";
import { Card, CardContent } from "./ui/card.js";

/**
 * Role + email + an optional professional-registration badge -- deliberately no display
 * name: the mock this was built from (the reset/forced-change screens) never shows one, only
 * role and email. `firstName`/`lastName` exist purely to strengthen the password policy's
 * "no personal info" rule (see packages/shared/src/password-policy.ts); this card has no
 * reason to surface them.
 */
export function IdentityCard({
  role,
  email,
  professionalRegistration,
}: {
  role: UserRole;
  email: string;
  professionalRegistration: string | null;
}) {
  const { t } = useTranslation(["roles", "recovery"]);

  return (
    <Card className="mb-4 flex-row items-center justify-between gap-3 py-2.5">
      <CardContent className="flex min-w-0 items-center gap-2 px-3.5">
        <UserRound className="size-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-sm font-semibold">{t(`roles:${role}`)}</div>
          <div className="overflow-hidden text-xs text-ellipsis text-muted-foreground">{email}</div>
        </div>
      </CardContent>
      {professionalRegistration && (
        <span
          title={t("recovery:professionalRegistrationLabel")}
          className="mr-3.5 flex-shrink-0 rounded-md bg-secondary px-2.5 py-1 font-mono text-xs whitespace-nowrap text-primary"
        >
          {professionalRegistration}
        </span>
      )}
    </Card>
  );
}

