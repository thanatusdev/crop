import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { type TenantDto } from "@crop/shared";
import { ChevronLeft, ChevronRight, Download, Plus, Eye, Pencil, Ban, RotateCcw } from "lucide-react";
import { cn } from "cn";
import { api, ApiError } from "../lib/api-client.js";
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
import { formatClinicCityState, formatClinicCnpj, summarizeClinics } from "../lib/clinic-display.js";

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
/** See `AdminEquipmentPage`'s own comment on this sentinel. */
const ALL = "__all__";

/**
 * Clinic registry -- the reshaped, filtered-to-CLINIC replacement for the old, single-field
 * `SuperadminTenantsPage`. `GET /tenants` keeps returning every tenant type unchanged (units'
 * and users' own clinic pickers still depend on that), so this page fetches the same endpoint
 * everyone else does and filters client-side, the same "always fetch broad, filter locally"
 * choice `AdminUnitsPage` already made for its own `?scope=all` fetch.
 *
 * The "Modalidades" column and its stat card are derived from `equipmentCount`/`modalities`
 * on the enriched `TenantDto` -- computed server-side by `PrismaTenantRepository.summarizeClinics`
 * from real `Equipment` rows, not re-entered on this form. See `docs/architecture.md` for why
 * the mock's own "Equipamentos & Modalidades" section was dropped from the create/edit form.
 *
 * Rebuilt on shadcn/ui alongside `AdminEquipmentPage`/`AdminUnitsPage` -- same primitives.
 */
export default function AdminClinicsPage() {
  const { t } = useTranslation(["adminClinics"]);

  const [tenants, setTenants] = useState<TenantDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmingDeactivation, setConfirmingDeactivation] = useState<TenantDto | null>(null);

  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const statusFilter = params.get("status") ?? "";
  const modalityFilter = params.get("modality") ?? "";
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
    void loadTenants();
  }, []);

  async function loadTenants() {
    setLoading(true);
    setLoadError(null);
    try {
      setTenants(await api.get<TenantDto[]>("/tenants"));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t("adminClinics:loadError"));
    } finally {
      setLoading(false);
    }
  }

  const clinics = useMemo(() => tenants.filter((tenant) => tenant.type === "CLINIC"), [tenants]);
  const summary = useMemo(() => summarizeClinics(clinics), [clinics]);

  const modalityOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const clinic of clinics) for (const modality of clinic.modalities) seen.add(modality);
    return Array.from(seen).sort();
  }, [clinics]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return clinics.filter((clinic) => {
      if (statusFilter === "active" && clinic.deactivated) return false;
      if (statusFilter === "inactive" && !clinic.deactivated) return false;
      if (modalityFilter && !clinic.modalities.includes(modalityFilter as (typeof clinic.modalities)[number])) return false;
      if (!needle) return true;
      return [clinic.name, clinic.cnpj, clinic.responsibleManager?.name].some((field) => field?.toLowerCase().includes(needle));
    });
  }, [clinics, search, statusFilter, modalityFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const visible = filtered.slice(pageStart, pageStart + pageSize);

  async function runAction(clinic: TenantDto, path: string) {
    setActionError(null);
    setPendingId(clinic.id);
    try {
      await api.post(`/tenants/${clinic.id}/${path}`);
      await loadTenants();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("adminClinics:genericActionError"));
    } finally {
      setPendingId(null);
      setConfirmingDeactivation(null);
    }
  }

  function exportCsv() {
    if (filtered.length === 0) return;
    const columns = [
      t("adminClinics:colName"),
      t("adminClinics:colModalities"),
      t("adminClinics:colCnpj"),
      t("adminClinics:colAddress"),
      t("adminClinics:colManager"),
      t("adminClinics:colStatus"),
    ];
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = filtered.map((clinic) =>
      [
        clinic.name,
        clinic.modalities.map((modality) => MODALITY_ABBREVIATION[modality]).join("/"),
        formatClinicCnpj(clinic) ?? "",
        formatClinicCityState(clinic) ?? "",
        clinic.responsibleManager?.name ?? "",
        clinic.deactivated ? t("adminClinics:statusInactive") : t("adminClinics:statusActive"),
      ]
        .map(escape)
        .join(",")
    );
    const csv = `\uFEFF${[columns.map(escape).join(","), ...rows].join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `clinicas-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <ConsoleShell activeNav="clinics" pageTitle={t("adminClinics:heading")}>
      <nav aria-label={t("adminClinics:breadcrumbList")}>
        <ol className="mb-3 flex list-none gap-1.5 p-0 text-sm text-muted-foreground">
          <li>{t("adminClinics:breadcrumbHome")}</li>
          <li aria-current="page" className="before:mr-1.5 before:content-['/']">
            {t("adminClinics:breadcrumbList")}
          </li>
        </ol>
      </nav>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mt-0 mb-1 text-xl font-semibold">{t("adminClinics:heading")}</h1>
          <p className="mt-0 text-muted-foreground">{t("adminClinics:subheading")}</p>
        </div>
        <Button asChild>
          <Link to="/superadmin/clinics/new">
            <Plus />
            {t("adminClinics:newClinic")}
          </Link>
        </Button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminClinics:statsTotalLabel")}</div>
            <div className="text-2xl font-semibold">{summary.total}</div>
            {summary.newThisMonth > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">{t("adminClinics:statsTotalNew", { count: summary.newThisMonth })}</p>
            )}
            {(summary.matrizCount > 0 || summary.filialCount > 0) && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("adminClinics:statsTotalBranches", { matriz: summary.matrizCount, filial: summary.filialCount })}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminClinics:statsActiveLabel")}</div>
            <div className="text-2xl font-semibold">{summary.active}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("adminClinics:statsActivePct", { pct: summary.activePct })}</p>
            {summary.inactive > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">{t("adminClinics:statsActiveNote", { count: summary.inactive })}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminClinics:statsEquipmentLabel")}</div>
            <div className="text-2xl font-semibold">{summary.totalEquipment}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("adminClinics:statsEquipmentNote")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminClinics:statsManagersLabel")}</div>
            <div className="text-2xl font-semibold">{summary.withResponsibleManager}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("adminClinics:statsManagersPct", { pct: summary.responsibleManagerCoveragePct })}</p>
            {summary.total - summary.withResponsibleManager > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("adminClinics:statsManagersNote", { count: summary.total - summary.withResponsibleManager })}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
              <Label htmlFor="clinic-search">{t("adminClinics:searchLabel")}</Label>
              <Input
                id="clinic-search"
                type="search"
                value={search}
                placeholder={t("adminClinics:searchPlaceholder")}
                onChange={(e) => setFilter("q", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="clinic-filter-status">{t("adminClinics:filterStatusLabel")}</Label>
              <Select value={statusFilter || ALL} onValueChange={(value) => setFilter("status", value === ALL ? "" : value)}>
                <SelectTrigger id="clinic-filter-status" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("adminClinics:filterStatusAll")}</SelectItem>
                  <SelectItem value="active">{t("adminClinics:statusActive")}</SelectItem>
                  <SelectItem value="inactive">{t("adminClinics:statusInactive")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="clinic-filter-modality">{t("adminClinics:filterModalityLabel")}</Label>
              <Select value={modalityFilter || ALL} onValueChange={(value) => setFilter("modality", value === ALL ? "" : value)}>
                <SelectTrigger id="clinic-filter-modality" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("adminClinics:filterModalityAll")}</SelectItem>
                  {modalityOptions.map((modality) => (
                    <SelectItem key={modality} value={modality}>
                      {MODALITY_ABBREVIATION[modality as keyof typeof MODALITY_ABBREVIATION]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" type="button" onClick={clearFilters}>
                {t("adminClinics:filterClear")}
              </Button>
              <Button variant="secondary" type="button" onClick={exportCsv} disabled={filtered.length === 0}>
                <Download />
                {t("adminClinics:export")}
              </Button>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
            {t("adminClinics:filterResultCount", { filtered: filtered.length, total: summary.total })}
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
                <button className="underline" onClick={() => void loadTenants()}>
                  {t("adminClinics:retry")}
                </button>
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <p aria-live="polite">{t("adminClinics:loading")}</p>
          ) : clinics.length === 0 ? (
            <p className="text-muted-foreground">{t("adminClinics:empty")}</p>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground">{t("adminClinics:emptyFiltered")}</p>
          ) : (
            <>
              <Table>
                <TableCaption className="sr-only">{t("adminClinics:tableCaption")}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adminClinics:colName")}</TableHead>
                    <TableHead>{t("adminClinics:colModalities")}</TableHead>
                    <TableHead>{t("adminClinics:colCnpj")}</TableHead>
                    <TableHead>{t("adminClinics:colAddress")}</TableHead>
                    <TableHead>{t("adminClinics:colManager")}</TableHead>
                    <TableHead>{t("adminClinics:colStatus")}</TableHead>
                    <TableHead>{t("adminClinics:colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((clinic) => {
                    const busy = pendingId === clinic.id;
                    const cityState = formatClinicCityState(clinic);
                    return (
                      <TableRow key={clinic.id}>
                        <TableCell>
                          <div className="font-medium">{clinic.name}</div>
                          {clinic.isMatriz !== null && (
                            <div className="text-xs text-muted-foreground">
                              {clinic.isMatriz ? t("adminClinics:branchMatriz") : t("adminClinics:branchFilial")}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {clinic.modalities.length > 0
                            ? clinic.modalities.map((modality) => MODALITY_ABBREVIATION[modality]).join(" / ")
                            : t("adminClinics:notRecorded")}
                        </TableCell>
                        <TableCell>{formatClinicCnpj(clinic) ?? t("adminClinics:notRecorded")}</TableCell>
                        <TableCell>{cityState ?? t("adminClinics:notRecorded")}</TableCell>
                        <TableCell>{clinic.responsibleManager?.name ?? t("adminClinics:noManager")}</TableCell>
                        <TableCell>
                          <Badge
                            className={cn(
                              "border-transparent",
                              clinic.deactivated ? "bg-[#3d1d1d] text-[#ff8b8b]" : "bg-[#1d3d2b] text-[#5fdc8a]"
                            )}
                          >
                            {clinic.deactivated ? t("adminClinics:statusInactive") : t("adminClinics:statusActive")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="secondary" size="icon-sm" aria-label={t("adminClinics:actionView")} asChild>
                                  <Link to={`/superadmin/clinics/${clinic.id}`}>
                                    <Eye />
                                  </Link>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t("adminClinics:actionView")}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="secondary" size="icon-sm" aria-label={t("adminClinics:actionEdit")} asChild>
                                  <Link to={`/superadmin/clinics/${clinic.id}/edit`}>
                                    <Pencil />
                                  </Link>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t("adminClinics:actionEdit")}</TooltipContent>
                            </Tooltip>
                            {clinic.deactivated ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="secondary"
                                    size="icon-sm"
                                    aria-label={t("adminClinics:actionReactivate")}
                                    disabled={busy}
                                    onClick={() => void runAction(clinic, "reactivate")}
                                  >
                                    <RotateCcw />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t("adminClinics:actionReactivate")}</TooltipContent>
                              </Tooltip>
                            ) : (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="destructive"
                                    size="icon-sm"
                                    aria-label={t("adminClinics:actionDeactivate")}
                                    disabled={busy}
                                    onClick={() => setConfirmingDeactivation(clinic)}
                                  >
                                    <Ban />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t("adminClinics:actionDeactivate")}</TooltipContent>
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
                  <Label htmlFor="clinic-page-size">{t("adminClinics:pageSizeLabel")}</Label>
                  <Select value={String(pageSize)} onValueChange={(value) => setFilter("size", value)}>
                    <SelectTrigger id="clinic-page-size" className="w-20">
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
                  {t("adminClinics:paginationSummary", {
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
                    aria-label={t("adminClinics:paginationPrev")}
                  >
                    <ChevronLeft />
                  </Button>
                  {Array.from({ length: pageCount }, (_unused, index) => index + 1).map((pageNumber) => (
                    <Button
                      key={pageNumber}
                      variant="secondary"
                      size="icon-sm"
                      aria-current={pageNumber === currentPage ? "page" : undefined}
                      aria-label={t("adminClinics:paginationPage", { page: pageNumber })}
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
                    aria-label={t("adminClinics:paginationNext")}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Deactivation is confirmed, and the message names how many equipment/unit records
          are linked -- both counts already live on the clinic's own enriched DTO, no extra
          fetch needed. Same pattern, and same reasoning, as the unit registry's own dialog. */}
      {confirmingDeactivation && (
        <Modal title={t("adminClinics:confirmDeactivateTitle")} onClose={() => setConfirmingDeactivation(null)}>
          <p>
            {confirmingDeactivation.equipmentCount > 0 || confirmingDeactivation.unitCount > 0
              ? t("adminClinics:confirmDeactivateBodyWithResources", {
                  name: confirmingDeactivation.name,
                  equipmentCount: confirmingDeactivation.equipmentCount,
                  unitCount: confirmingDeactivation.unitCount,
                })
              : t("adminClinics:confirmDeactivateBodyNoResources", { name: confirmingDeactivation.name })}
          </p>
          <div className="mt-4 flex justify-end gap-2.5">
            <Button variant="outline" onClick={() => setConfirmingDeactivation(null)}>
              {t("adminClinics:confirmCancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={pendingId === confirmingDeactivation.id}
              onClick={() => void runAction(confirmingDeactivation, "deactivate")}
            >
              {t("adminClinics:confirmDeactivateConfirm")}
            </Button>
          </div>
        </Modal>
      )}
    </ConsoleShell>
  );
}
