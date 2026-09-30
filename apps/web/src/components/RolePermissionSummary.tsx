import { useTranslation } from "react-i18next";
import { ROLE_CAPABILITIES, type UserRole } from "@crop/shared";
import { Card, CardContent } from "./ui/card.js";

/**
 * Read-only, role-derived -- not a real per-user grant model. See `ROLE_CAPABILITIES`'s own
 * docstring for why this shows fewer, more specific capabilities than the mock's three
 * example checkboxes: two of those three ("Relatórios de Produtividade", "Supervisão de
 * Intercorrências") don't correspond to any real feature in this app. Rendered as a plain
 * list, not `role="radio"`/checkboxes -- these aren't a mutually exclusive choice, and
 * they're not independently toggleable either (see `PasswordPolicyChecklist` for the
 * identical reasoning applied to a different plain list).
 *
 * Migrated to shadcn's `Card` alongside `AdminUsersPage` (one of its two callers).
 * `WorkstationPage`, its other caller, is migrated later (Phase 3e) -- until then this
 * renders as a self-contained light card on that one still-dark page, the same accepted,
 * temporary, purely cosmetic inconsistency `docs/architecture.md` already documents for
 * `ConsoleShell`'s own unclaimed `<main>` background: nothing about a light card on a dark
 * page fails contrast (it's fully self-contained, own bg + fg), so it's tolerated rather
 * than blocking this component's migration on a page three phases away.
 */
export function RolePermissionSummary({ role }: { role: UserRole }) {
  const { t } = useTranslation(["permissions"]);
  const capabilities = ROLE_CAPABILITIES[role];

  return (
    <Card className="mb-3.5 py-4">
      <CardContent>
        <strong className="text-sm">{t("permissions:title")}</strong>
        {capabilities.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted-foreground">{t("permissions:empty")}</p>
        ) : (
          <ul className="mt-1.5 list-disc pl-5 text-sm">
            {capabilities.map((key) => (
              <li key={key}>{t(`permissions:${key}`)}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

