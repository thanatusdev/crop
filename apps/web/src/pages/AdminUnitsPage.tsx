import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { type MyClinic, type TenantDto, type UnitDto } from "@crop/shared";
import { ChevronLeft, ChevronRight, Download, Plus, Eye, Pencil, Ban, RotateCcw } from "lucide-react";
import { cn } from "cn";
import { api, ApiError } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { Modal } from "../components/Modal.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Badge } from "../components/ui/badge.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.js";
import { MODALITY_ABBREVIATION } from "../lib/equipment-display.js";
import { ESTABLISHMENT_TYPE_LABEL_KEY, ESTABLISHMENT_TYPE_ORDER, formatUnitCityState, summarizeUnits } from "../lib/unit-display.js";

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
/** See `AdminEquipmentPage`'s own comment on this sentinel. */
const ALL = "__all__";

/**
 * Unit registry. Search/filter/pagination/export all run client-side, over one fetch of
 * `GET /units?scope=all` -- every unit across every clinic the caller can reach (see
 * `ListAccessibleUnitsHandler`), for every role, unconditionally.
 *
 * That "always scope=all" choice is simpler than it looks: for a plain single-clinic
 * `CLINIC_ADMIN`, `ListAccessibleUnitsHandler` resolves "every clinic I can reach" down to
 * exactly their one home clinic anyway -- the identical result the old single-clinic
 * `?clinicTenantId=` default gave. There is no separate "am I multi-clinic" branch to get
 * wrong, and an `OPERATOR_ADMIN` whose access comes only through
 * `Tenant.operatorTenantId` -- which `GET /auth/me/clinics` has never included, a
 * pre-existing gap this page inherits rather than fixes -- now at least sees their linked
 * clinic's units here, since `ListAccessibleUnitsHandler` (unlike `ListMyClinicsHandler`)
 * already accounts for that link.
 *
 * `clinicOptions` (sourced the same way `AdminUsersPage`'s clinic picker already is: `GET
 * /tenants` for a `PLATFORM_ADMIN`, `GET /auth/me/clinics` otherwise) is used only for the
 * clinic filter's labels and the table's Clínica column -- never to decide what to fetch.
 * A unit whose clinic isn't in that list (the operator-link gap above) falls back to
 * showing the raw clinic id, the same graceful-degradation `AdminEquipmentPage`'s own unit
 * name lookup already does for an unknown id.
 *
 * Rebuilt on shadcn/ui alongside `AdminEquipmentPage` -- same primitives, same pattern.
 */
export default function AdminUnitsPage() {
  const { t } = useTranslation(["adminUnits", "unitForm"]);
  const { user } = useAuth();
  const isSuperadmin = user?.role === "PLATFORM_ADMIN";

  const [tenants, setTenants] = useState<TenantDto[]>([]);
  const [myClinics, setMyClinics] = useState<MyClinic[]>([]);
  const clinicOptions = useMemo(
    () =>
      isSuperadmin
        ? tenants.filter((tenant) => tenant.type === "CLINIC").map((tenant) => ({ id: tenant.id, name: tenant.name }))
        : myClinics.map((clinic) => ({ id: clinic.id, name: clinic.name })),
    [isSuperadmin, tenants, myClinics]
  );
  const clinicNameById = useMemo(() => new Map(clinicOptions.map((clinic) => [clinic.id, clinic.name])), [clinicOptions]);

  function clinicName(clinicTenantId: string): string {
    return clinicNameById.get(clinicTenantId) ?? clinicTenantId;
  }

  const [units, setUnits] = useState<UnitDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmingDeactivation, setConfirmingDeactivation] = useState<UnitDto | null>(null);

  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const statusFilter = params.get("status") ?? "";
  const clinicFilter = params.get("clinic") ?? "";
  const typeFilter = params.get("type") ?? "";
  const pageSize = Number(params.get("size") ?? PAGE_SIZE_OPTIONS[0]);
  const page = Math.max(1, Number(params.get("page") ?? 1));

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next, { replace: true });
  }

  function clearFilters() {
    setParams(new URLSearchParams(), { replace: true });
  }

  useEffect(() => {
    if (isSuperadmin) void loadTenants();
    else void loadMyClinics();
    void loadUnits();
  }, []);

  async function loadTenants() {
    try {
      setTenants(await api.get<TenantDto[]>("/tenants"));
    } catch {
      // Non-fatal -- the clinic filter/column just falls back to raw ids.
    }
  }

  async function loadMyClinics() {
    try {
      setMyClinics(await api.get<MyClinic[]>("/auth/me/clinics"));
    } catch {
      // Non-fatal.
    }
  }

  async function loadUnits() {
    setLoading(true);
    setLoadError(null);
    try {
      setUnits(await api.get<UnitDto[]>("/units?scope=all"));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t("adminUnits:loadError"));
    } finally {
      setLoading(false);
    }
  }

  const summary = useMemo(() => summarizeUnits(units), [units]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return units.filter((unit) => {
      if (statusFilter === "active" && unit.deactivated) return false;
      if (statusFilter === "inactive" && !unit.deactivated) return false;
      if (clinicFilter && unit.clinicTenantId !== clinicFilter) return false;
      if (typeFilter && unit.establishmentType !== typeFilter) return false;
      if (!needle) return true;
      return [unit.name, unit.cnesCode, unit.city, clinicName(unit.clinicTenantId)].some((field) => field?.toLowerCase().includes(needle));
    });
  }, [units, search, statusFilter, clinicFilter, typeFilter, clinicNameById]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const visible = filtered.slice(pageStart, pageStart + pageSize);

  async function runAction(unit: UnitDto, path: string) {
    setActionError(null);
    setPendingId(unit.id);
    try {
      await api.post(`/units/${unit.id}/${path}`);
      await loadUnits();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("adminUnits:genericActionError"));
    } finally {
      setPendingId(null);
      setConfirmingDeactivation(null);
    }
  }

  function exportCsv() {
    if (filtered.length === 0) return;
    const columns = [
      t("adminUnits:colName"),
      t("adminUnits:colClinic"),
      t("adminUnits:colType"),
      "CNES",
      t("adminUnits:colAddress"),
      t("adminUnits:colStatus"),
      t("unitForm:sectionModality"),
    ];
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = filtered.map((unit) =>
      [
        unit.name,
        clinicName(unit.clinicTenantId),
        unit.establishmentType ? t(ESTABLISHMENT_TYPE_LABEL_KEY[unit.establishmentType]) : "",
        unit.cnesCode ?? "",
        formatUnitCityState(unit) ?? "",
        unit.deactivated ? t("adminUnits:statusInactive") : t("adminUnits:statusActive"),
        unit.declaredModalities.map((modality) => MODALITY_ABBREVIATION[modality]).join("/"),
      ]
        .map(escape)
        .join(",")
    );
    const csv = `\uFEFF${[columns.map(escape).join(","), ...rows].join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `unidades-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <ConsoleShell activeNav="units" pageTitle={t("adminUnits:heading")}>
      <nav aria-label={t("adminUnits:breadcrumbList")}>
        <ol className="mb-3 flex list-none gap-1.5 p-0 text-sm text-muted-foreground">
          <li>{t("adminUnits:breadcrumbHome")}</li>
          <li aria-current="page" className="before:mr-1.5 before:content-['/']">
            {t("adminUnits:breadcrumbList")}
          </li>
        </ol>
      </nav>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mt-0 mb-1 text-xl font-semibold">{t("adminUnits:heading")}</h1>
          <p className="mt-0 text-muted-foreground">{t("adminUnits:subheading")}</p>
        </div>
        <Button asChild>
          <Link to="/admin/units/new">
            <Plus />
            {t("adminUnits:newUnit")}
          </Link>
        </Button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminUnits:statsTotalLabel")}</div>
            <div className="text-2xl font-semibold">{summary.total}</div>
            {summary.newThisMonth > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">{t("adminUnits:statsTotalNew", { count: summary.newThisMonth })}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminUnits:statsActiveLabel")}</div>
            <div className="text-2xl font-semibold">{summary.active}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("adminUnits:statsActivePct", { pct: summary.activePct })}</p>
            {summary.inactive > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">{t("adminUnits:statsActiveNote", { count: summary.inactive })}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminUnits:statsRoomsLabel")}</div>
            <div className="text-2xl font-semibold">{summary.totalRooms}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("adminUnits:statsRoomsNote")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminUnits:statsEquipmentLabel")}</div>
            <div className="text-2xl font-semibold">{summary.totalEquipment}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("adminUnits:statsEquipmentNote")}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
              <Label htmlFor="unit-search">{t("adminUnits:searchLabel")}</Label>
              <Input
                id="unit-search"
                type="search"
                value={search}
                placeholder={t("adminUnits:searchPlaceholder")}
                onChange={(e) => setFilter("q", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="unit-filter-status">{t("adminUnits:filterStatusLabel")}</Label>
              <Select value={statusFilter || ALL} onValueChange={(value) => setFilter("status", value === ALL ? "" : value)}>
                <SelectTrigger id="unit-filter-status" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("adminUnits:filterStatusAll")}</SelectItem>
                  <SelectItem value="active">{t("adminUnits:statusActive")}</SelectItem>
                  <SelectItem value="inactive">{t("adminUnits:statusInactive")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="unit-filter-clinic">{t("adminUnits:filterClinicLabel")}</Label>
              <Select value={clinicFilter || ALL} onValueChange={(value) => setFilter("clinic", value === ALL ? "" : value)}>
                <SelectTrigger id="unit-filter-clinic" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("adminUnits:filterClinicAll")}</SelectItem>
                  {clinicOptions.map((clinic) => (
                    <SelectItem key={clinic.id} value={clinic.id}>
                      {clinic.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="unit-filter-type">{t("adminUnits:filterTypeLabel")}</Label>
              <Select value={typeFilter || ALL} onValueChange={(value) => setFilter("type", value === ALL ? "" : value)}>
                <SelectTrigger id="unit-filter-type" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("adminUnits:filterTypeAll")}</SelectItem>
                  {ESTABLISHMENT_TYPE_ORDER.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(ESTABLISHMENT_TYPE_LABEL_KEY[type])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" type="button" onClick={clearFilters}>
                {t("adminUnits:filterClear")}
              </Button>
              <Button variant="secondary" type="button" onClick={exportCsv} disabled={filtered.length === 0}>
                <Download />
                {t("adminUnits:export")}
              </Button>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
            {t("adminUnits:filterResultCount", { filtered: filtered.length, total: summary.total })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {actionError && (
            <Alert variant="destructive" className="mb-3">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}

          {loadError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {loadError}{" "}
                <button className="underline" onClick={() => void loadUnits()}>
                  {t("adminUnits:retry")}
                </button>
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <p aria-live="polite">{t("adminUnits:loading")}</p>
          ) : units.length === 0 ? (
            <p className="text-muted-foreground">{t("adminUnits:empty")}</p>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground">{t("adminUnits:emptyFiltered")}</p>
          ) : (
            <>
              <Table>
                <TableCaption className="sr-only">{t("adminUnits:tableCaption")}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adminUnits:colName")}</TableHead>
                    <TableHead>{t("adminUnits:colClinic")}</TableHead>
                    <TableHead>{t("adminUnits:colType")}</TableHead>
                    <TableHead>{t("adminUnits:colAddress")}</TableHead>
                    <TableHead>{t("adminUnits:colStatus")}</TableHead>
                    <TableHead>{t("adminUnits:colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((unit) => {
                    const busy = pendingId === unit.id;
                    const cityState = formatUnitCityState(unit);
                    return (
                      <TableRow key={unit.id}>
                        <TableCell>
                          <div className="font-medium">{unit.name}</div>
                          <div className="text-xs text-muted-foreground">{unit.cnesCode ? `CNES ${unit.cnesCode}` : t("adminUnits:notRecorded")}</div>
                        </TableCell>
                        <TableCell>{clinicName(unit.clinicTenantId)}</TableCell>
                        <TableCell>{unit.establishmentType ? t(ESTABLISHMENT_TYPE_LABEL_KEY[unit.establishmentType]) : t("adminUnits:notRecorded")}</TableCell>
                        <TableCell>{cityState ?? t("adminUnits:notRecorded")}</TableCell>
                        <TableCell>
                          <Badge
                            className={cn(
                              "border-transparent",
                              unit.deactivated ? "bg-[#3d1d1d] text-[#ff8b8b]" : "bg-[#1d3d2b] text-[#5fdc8a]"
                            )}
                          >
                            {unit.deactivated ? t("adminUnits:statusInactive") : t("adminUnits:statusActive")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="secondary" size="icon-sm" aria-label={t("adminUnits:actionView")} asChild>
                                  <Link to={`/admin/units/${unit.id}`}>
                                    <Eye />
                                  </Link>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t("adminUnits:actionView")}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="secondary" size="icon-sm" aria-label={t("adminUnits:actionEdit")} asChild>
                                  <Link to={`/admin/units/${unit.id}/edit`}>
                                    <Pencil />
                                  </Link>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t("adminUnits:actionEdit")}</TooltipContent>
                            </Tooltip>
                            {unit.deactivated ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="secondary"
                                    size="icon-sm"
                                    aria-label={t("adminUnits:actionReactivate")}
                                    disabled={busy}
                                    onClick={() => void runAction(unit, "reactivate")}
                                  >
                                    <RotateCcw />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t("adminUnits:actionReactivate")}</TooltipContent>
                              </Tooltip>
                            ) : (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="destructive"
                                    size="icon-sm"
                                    aria-label={t("adminUnits:actionDeactivate")}
                                    disabled={busy}
                                    onClick={() => setConfirmingDeactivation(unit)}
                                  >
                                    <Ban />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t("adminUnits:actionDeactivate")}</TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="unit-page-size">{t("adminUnits:pageSizeLabel")}</Label>
                  <Select value={String(pageSize)} onValueChange={(value) => setFilter("size", value)}>
                    <SelectTrigger id="unit-page-size" className="w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZE_OPTIONS.map((size) => (
                        <SelectItem key={size} value={String(size)}>
                          {size}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <span aria-live="polite" className="text-sm text-muted-foreground">
                  {t("adminUnits:paginationSummary", {
                    from: filtered.length === 0 ? 0 : pageStart + 1,
                    to: Math.min(pageStart + pageSize, filtered.length),
                    total: filtered.length,
                  })}
                </span>
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    disabled={currentPage <= 1}
                    onClick={() => setFilter("page", String(currentPage - 1))}
                    aria-label={t("adminUnits:paginationPrev")}
                  >
                    <ChevronLeft />
                  </Button>
                  {Array.from({ length: pageCount }, (_unused, index) => index + 1).map((pageNumber) => (
                    <Button
                      key={pageNumber}
                      variant="secondary"
                      size="icon-sm"
                      aria-current={pageNumber === currentPage ? "page" : undefined}
                      aria-label={t("adminUnits:paginationPage", { page: pageNumber })}
                      className={cn(pageNumber === currentPage && "bg-accent")}
                      onClick={() => setFilter("page", String(pageNumber))}
                    >
                      {pageNumber}
                    </Button>
                  ))}
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    disabled={currentPage >= pageCount}
                    onClick={() => setFilter("page", String(currentPage + 1))}
                    aria-label={t("adminUnits:paginationNext")}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Deactivation is confirmed, and the message names how many equipment records are
          affected -- the count already lives on the unit's own enriched DTO, no extra fetch
          needed. Same pattern, and same reasoning, as the equipment registry's own dialog. */}
      {confirmingDeactivation && (
        <Modal title={t("adminUnits:confirmDeactivateTitle")} onClose={() => setConfirmingDeactivation(null)}>
          <p>
            {confirmingDeactivation.equipmentCount > 0
              ? t("adminUnits:confirmDeactivateBodyWithEquipment", {
                  name: confirmingDeactivation.name,
                  count: confirmingDeactivation.equipmentCount,
                })
              : t("adminUnits:confirmDeactivateBodyNoEquipment", { name: confirmingDeactivation.name })}
          </p>
          <div className="mt-4 flex justify-end gap-2.5">
            <Button variant="outline" onClick={() => setConfirmingDeactivation(null)}>
              {t("adminUnits:confirmCancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={pendingId === confirmingDeactivation.id}
              onClick={() => void runAction(confirmingDeactivation, "deactivate")}
            >
              {t("adminUnits:confirmDeactivateConfirm")}
            </Button>
          </div>
        </Modal>
      )}
    </ConsoleShell>
  );
}
