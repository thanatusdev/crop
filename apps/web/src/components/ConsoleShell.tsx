import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { EquipmentDto, TenantDto, UnitDto } from "@crop/shared";
import { Bell, Zap } from "lucide-react";
import { cn } from "cn";
import { api } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { computeNavPermissions } from "../lib/nav-permissions.js";
import { Button } from "./ui/button.js";

export type ConsoleNavKey = "dashboard" | "users" | "clinics" | "units" | "equipment" | "nursing" | "agreements";

/**
 * The shared light-theme sidebar+topbar chrome (Dashboard, Gestores & Usuários, Unidades,
 * Equipamentos, and the superadmin Tenants page) -- built to close the "every page
 * re-implements its own `<header className=\"topbar\">` shell" duplication once a fifth
 * admin-ish page (Units) needed the same chrome as the first four. Rebuilt on shadcn/ui in
 * a later pass -- the highest-blast-radius single file in that migration, since every page
 * that renders inside it (see the list above) inherits whatever this file does.
 *
 * Originally reversed an earlier, explicit "keep dark theme" call for `AdminUsersPage`
 * specifically, in favor of matching the RadLink console mock these five pages are modeled
 * on -- by the time every other page migrated too (see docs/architecture.md), light became
 * the app's one and only theme, not something distinguishing this shell from the rest.
 * `SessionPage`, `AuditPage`, `ClinicHomePage`, and `LatencyClockPage` still don't render
 * inside this shell, but for an unrelated reason: no sidebar nav/topbar chrome fits a
 * full-bleed video console, a page with no nav needs, or a standalone stub outside the
 * authenticated app entirely -- not a theme difference anymore.
 *
 * Three things the mock showed that this deliberately does NOT reproduce, each a considered
 * substitution rather than an oversight (see docs/architecture.md for the full reasoning):
 *   - the topbar's fabricated "GRID DICOM / PACS: ONLINE · 12ms (TLS 1.3)" pill becomes a
 *     real equipment-health aggregate for the caller's own active clinic;
 *   - the sidebar footer's regulatory-compliance claim ("HIPAA", "credenciados CFM/SBIS")
 *     is dropped for a neutral version stamp -- this codebase has made no attempt to
 *     actually satisfy or document either certification anywhere;
 *   - the "Configurações" gear is dropped outright (nothing exists behind it); the
 *     notification bell stays as inert, `aria-hidden` decoration only.
 */
export function ConsoleShell({
  activeNav,
  pageTitle,
  children,
  wide = false,
}: {
  activeNav: ConsoleNavKey;
  pageTitle: string;
  children: React.ReactNode;
  /** Widens the content column from the shell's own default `max-w-[960px]` to
   * `max-w-[1440px]` -- `NursingPage` is the one page in this shell whose own content (the
   * queue rail, exam details, and now the room's chat, all side by side) genuinely needs
   * more room than every admin-table page this shell otherwise serves; see that page's own
   * layout for why. Every other page keeps the narrower default unconditionally, since
   * widening it for everyone would reflow five admin screens that have no use for the extra
   * width. */
  wide?: boolean;
}) {
  const { t } = useTranslation(["shell", "roles"]);
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const nav = computeNavPermissions(user?.role);

  const [equipmentHealth, setEquipmentHealth] = useState<{ online: number; total: number } | null>(null);
  const [clinicCount, setClinicCount] = useState<number | null>(null);
  const [unitCount, setUnitCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Every one of these three reads its scope from the caller's *active* tenant server-side
    // (the JWT's `tenantId`, not `homeTenantId` -- see `switchActiveClinic`'s own docstring),
    // so this has to re-run whenever that changes, not only on mount. It didn't used to: this
    // effect ran once with an empty dependency array, which is why the header's equipment-health
    // pill and the sidebar's unit count kept showing the *previous* clinic's numbers after a
    // multi-clinic Manager switched -- until a full page reload re-ran everything from scratch.
    // Cleared up front, not left holding the old tenant's numbers, for the same reason: a stale
    // "12/14 online" surviving the switch and just sitting there until the new fetch resolves
    // would read as current, not stale, to whoever is looking at it.
    setEquipmentHealth(null);
    setUnitCount(null);
    setClinicCount(null);

    api
      .get<EquipmentDto[]>("/equipment")
      .then((list) => {
        if (cancelled) return;
        setEquipmentHealth({ online: list.filter((e) => e.status === "ONLINE").length, total: list.length });
      })
      .catch(() => {
        // Non-fatal -- the health pill just stays blank, same reasoning as every other
        // "decorative, best-effort" fetch in this app (see AdminUsersPage's loadTenants).
      });

    api
      .get<UnitDto[]>("/units")
      .then((list) => {
        if (!cancelled) setUnitCount(list.length);
      })
      .catch(() => {});

    if (nav.canManagePlatform) {
      api
        .get<TenantDto[]>("/tenants")
        .then((list) => {
          if (!cancelled) setClinicCount(list.filter((tenant) => tenant.type === "CLINIC").length);
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [user?.tenantId, nav.canManagePlatform]);

  async function handleSignOut() {
    await logout();
    navigate("/login");
  }

  const items: Array<{
    key: ConsoleNavKey;
    to: string;
    label: string;
    visible: boolean;
    count?: number | null;
  }> = [
    // Hidden for NURSING -- see canViewOperations's own docstring in nav-permissions.ts.
    { key: "dashboard", to: "/", label: t("shell:navDashboard"), visible: nav.canViewOperations },
    { key: "users", to: "/admin/users", label: t("shell:navUsers"), visible: nav.canManageUsers },
    { key: "clinics", to: "/superadmin/clinics", label: t("shell:navClinics"), visible: nav.canManagePlatform, count: clinicCount },
    { key: "units", to: "/admin/units", label: t("shell:navUnits"), visible: nav.canManageUnits, count: unitCount },
    { key: "equipment", to: "/admin/equipment", label: t("shell:navEquipment"), visible: nav.canManageEquipment },
    { key: "nursing", to: "/enfermagem", label: t("shell:navNursing"), visible: nav.canManageQueue },
    { key: "agreements", to: "/contratos", label: t("shell:navAgreements"), visible: nav.canManageAgreements },
  ];

  return (
    // `<main>` claims `bg-background`/`text-foreground` directly now that every page this
    // shell renders is on shadcn/Tailwind (see docs/architecture.md's shadcn migration
    // entries) -- it couldn't while any sibling page still depended on inheriting the old
    // stylesheet's dark defaults through it (the same class of bug documented there: a
    // shared ancestor claiming a *replacement* color breaks whatever hasn't moved yet).
    // With nothing left unmigrated, every one of those pages' own `var(--color-muted)`/
    // `var(--color-accent)` inline-style workarounds for text floating directly in this
    // `<main>` was removed in the same pass as this claim, in favor of the real
    // `text-muted-foreground`/`text-primary` utilities they were always standing in for.
    <div className="flex min-h-screen" lang="pt-BR">
      <aside className="flex w-62 flex-shrink-0 flex-col border-r bg-sidebar p-3 py-5 text-foreground">
        <div className="flex items-center gap-2 px-2 pb-5 text-[1.05em] font-bold">
          <Zap aria-hidden="true" className="size-4 text-primary" />
          <span>
            RadLink
            <small className="block text-[0.7em] font-normal tracking-wide text-muted-foreground">{t("shell:hubLabel")}</small>
          </span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5" aria-label={t("shell:navLabel")}>
          {items
            .filter((item) => item.visible)
            .map((item) => (
              <Link
                key={item.key}
                to={item.to}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm text-foreground no-underline hover:bg-secondary",
                  activeNav === item.key && "bg-sidebar-accent font-semibold text-sidebar-accent-foreground hover:bg-sidebar-accent"
                )}
              >
                <span>{item.label}</span>
                {item.count !== undefined && item.count !== null && (
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{item.count}</span>
                )}
              </Link>
            ))}
        </nav>
        <div className="mt-3 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
          RadLink v1 · {t("shell:footerNote")}
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between gap-4 border-b bg-card px-6 py-4 text-foreground">
          <strong>{pageTitle}</strong>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-xs text-muted-foreground">
              <span aria-hidden="true" className="size-1.5 flex-shrink-0 rounded-full bg-[#5fdc8a]" />
              {equipmentHealth
                ? t("shell:healthPill", { online: equipmentHealth.online, total: equipmentHealth.total })
                : t("shell:healthPillLoading")}
            </span>
            {/* Decorative only -- no notification system exists behind this. */}
            <Bell aria-hidden="true" className="size-[18px] text-muted-foreground" />
            <div className="flex items-center gap-3 text-sm">
              <span>{user ? t(`roles:${user.role}`) : ""}</span>
              <Button variant="secondary" size="sm" onClick={handleSignOut}>
                {t("shell:signOut")}
              </Button>
            </div>
          </div>
        </header>
        <main className={cn("mx-auto bg-background px-5 py-8 text-foreground", wide ? "max-w-[1440px]" : "max-w-[960px]")}>{children}</main>
      </div>
    </div>
  );
}


