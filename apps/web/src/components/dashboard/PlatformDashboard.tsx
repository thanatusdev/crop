import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { PlatformStatsDto } from "@crop/shared";
import { api } from "../../lib/api-client.js";
import { ConsoleShell } from "../ConsoleShell.js";
import { Button } from "../ui/button.js";
import { Card, CardContent } from "../ui/card.js";
import { Skeleton } from "../ui/skeleton.js";
import { Alert, AlertDescription } from "../ui/alert.js";

interface StatCard {
  key: string;
  label: string;
  value: number;
  note: string;
  /** Only the cross-tenant admin screens -- `/admin/users`/`/admin/equipment` are scoped to the
   * caller's own (PLATFORM) tenant, so linking there from a platform-wide total would mislead. */
  to?: string;
}

/**
 * The PLATFORM_ADMIN's landing page: platform-wide totals only, from `GET /platform/stats`.
 * Replaces `DashboardPage`'s tenant-scoped equipment view for this role -- the PLATFORM tenant
 * owns no equipment, queue or sessions, so that view only ever showed zeros and an empty state.
 */
export function PlatformDashboard() {
  const { t } = useTranslation(["dashboard"]);
  const [stats, setStats] = useState<PlatformStatsDto | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setError(false);
    api
      .get<PlatformStatsDto>("/platform/stats")
      .then(setStats)
      .catch(() => setError(true));
  }, []);

  useEffect(load, [load]);

  const cards: StatCard[] = stats
    ? [
        {
          key: "users",
          label: t("dashboard:platformUsersLabel"),
          value: stats.users.total,
          note: t("dashboard:platformUsersNote", { count: stats.users.activeLast30Days }),
        },
        {
          key: "clinics",
          label: t("dashboard:platformClinicsLabel"),
          value: stats.clinics.active,
          note: t("dashboard:platformDeactivatedNote", { count: stats.clinics.deactivated }),
          to: "/superadmin/clinics",
        },
        {
          key: "operators",
          label: t("dashboard:platformOperatorsLabel"),
          value: stats.operators.active,
          note: t("dashboard:platformDeactivatedNote", { count: stats.operators.deactivated }),
          to: "/superadmin/operadoras",
        },
        {
          key: "equipment",
          label: t("dashboard:platformEquipmentLabel"),
          value: stats.equipment.total,
          note: t("dashboard:statsEquipmentNote", { count: stats.equipment.online }),
        },
        {
          key: "sessions",
          label: t("dashboard:platformSessionsLabel"),
          value: stats.sessions.active,
          note: t("dashboard:platformSessionsNote"),
        },
        {
          key: "agreements",
          label: t("dashboard:statsAgreementsLabel"),
          value: stats.agreements.active,
          note: t("dashboard:statsAgreementsNote", { count: stats.agreements.pending }),
          to: "/contratos",
        },
      ]
    : [];

  return (
    <ConsoleShell activeNav="dashboard" pageTitle={t("dashboard:platformHeading")}>
      <h1 className="sr-only">{t("dashboard:platformHeading")}</h1>
      <p className="mt-0 mb-4 text-muted-foreground">{t("dashboard:platformSubheading")}</p>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            {t("dashboard:platformLoadError")}
            <Button variant="outline" size="sm" onClick={load}>
              {t("dashboard:retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {stats
            ? cards.map((card) => (
                <Card key={card.key}>
                  <CardContent>
                    <div className="text-sm text-muted-foreground">{card.label}</div>
                    <div className="text-2xl font-semibold">{card.value}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{card.note}</p>
                    {card.to && (
                      <Link to={card.to} className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
                        {t("dashboard:platformViewAll")}
                      </Link>
                    )}
                  </CardContent>
                </Card>
              ))
            : Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      )}
    </ConsoleShell>
  );
}
