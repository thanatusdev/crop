import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { EquipmentStatus, ExamModality, type EquipmentDto, type UnitDto } from "@crop/shared";
import { ChevronLeft, ChevronRight, Download, Plus } from "lucide-react";
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
import {
  MODALITY_ABBREVIATION,
  MODALITY_ORDER,
  displayStatusOf,
  statusLabelKeyOf,
  summarize,
  tailwindBadgeClassOf,
  type DisplayStatus,
} from "../lib/equipment-display.js";

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const STATUS_FILTERS: readonly DisplayStatus[] = ["online", "maintenance", "degraded", "offline", "inactive"];
/** Radix `Select.Item` rejects an empty-string `value` -- see `NursingPage`'s own `UNSET`
 * constant for the identical reasoning. Every filter `<Select>` on this page uses this same
 * sentinel for its "all/none" option. */
const ALL = "__all__";

/**
 * Equipment registry. Search, filtering, sorting and pagination are all client-side, over the
 * full array `GET /equipment` returns for the caller's tenant.
 *
 * That is a deliberate scope decision, not an oversight: the endpoint has always returned a
 * tenant's equipment unpaginated, no list in this app is server-paginated, and a clinic's fleet
 * is tens of devices, not thousands. Doing it in the browser keeps the summary cards, the
 * table and the CSV export reading from one array that cannot disagree with itself. The point
 * where this stops being the right answer is a tenant large enough that the payload itself
 * hurts -- at which point the filters here become query parameters and the counts need their
 * own endpoint, because they would no longer be derivable from a single page of results.
 *
 * Filter state lives in the URL query string so a filtered view is linkable and survives the
 * round trip to the edit form and back. Rebuilt on shadcn/ui in a later pass -- `Table` for
 * the listing, `Select` for the three filters, `Badge` for status (`tailwindBadgeClassOf`,
 * same hex pairs as the old `.badge.online`/etc.).
 */
export default function AdminEquipmentPage() {
  const { t } = useTranslation(["adminEquipment", "equipmentForm"]);

  const [equipment, setEquipment] = useState<EquipmentDto[]>([]);
  const [units, setUnits] = useState<UnitDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmingDeactivation, setConfirmingDeactivation] = useState<EquipmentDto | null>(null);

  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const statusFilter = params.get("status") ?? "";
  const modalityFilter = params.get("modality") ?? "";
  const unitFilter = params.get("unit") ?? "";
  const pageSize = Number(params.get("size") ?? PAGE_SIZE_OPTIONS[0]);
  const page = Math.max(1, Number(params.get("page") ?? 1));

  /**
   * Any filter change resets to page 1 -- otherwise narrowing a 5-page result set while on
   * page 4 lands the user on an empty page that looks like "no results."
   */
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
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      // Units are fetched alongside, not lazily: every row needs to resolve `unitId` to a
      // name, so deferring it would render the whole table with placeholder units first.
      const [equipmentList, unitList] = await Promise.all([
        api.get<EquipmentDto[]>("/equipment"),
        // Non-fatal on its own -- the table falls back to showing the raw id, which is worse
        // but still usable, rather than failing the whole screen over the unit lookup.
        api.get<UnitDto[]>("/units").catch(() => [] as UnitDto[]),
      ]);
      setEquipment(equipmentList);
      setUnits(unitList);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t("adminEquipment:loadError"));
    } finally {
      setLoading(false);
    }
  }

  const unitNameById = useMemo(() => new Map(units.map((unit) => [unit.id, unit.name])), [units]);

  function unitName(unitId: string | null): string {
    if (!unitId) return t("adminEquipment:unassignedUnit");
    return unitNameById.get(unitId) ?? unitId;
  }

  const summary = useMemo(() => summarize(equipment), [equipment]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return equipment.filter((item) => {
      if (statusFilter && displayStatusOf(item) !== statusFilter) return false;
      if (modalityFilter && item.modality !== modalityFilter) return false;
      if (unitFilter && item.unitId !== unitFilter) return false;
      if (!needle) return true;
      // The four columns the search box's own label names. Unit/room are deliberately not
      // searched here: they have their own dedicated filter, and folding them in would make
      // an empty result with a unit filter applied confusing to reason about.
      return [item.name, item.brand, item.model, item.serialNumber].some((field) => field?.toLowerCase().includes(needle));
    });
  }, [equipment, search, statusFilter, modalityFilter, unitFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Clamped rather than reset: if the data shrinks underneath a deep page (another admin
  // deactivating rows, say), showing the last real page beats showing nothing.
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const visible = filtered.slice(pageStart, pageStart + pageSize);

  async function runAction(item: EquipmentDto, path: string) {
    setActionError(null);
    setPendingId(item.id);
    try {
      await api.post(`/equipment/${item.id}/${path}`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("adminEquipment:genericActionError"));
    } finally {
      setPendingId(null);
      setConfirmingDeactivation(null);
    }
  }

  /**
   * Exports the *filtered* rows, not the whole fleet -- the button sits inside the filter bar,
   * so "export" meaning anything other than "what I am looking at" would be surprising.
   *
   * Built and downloaded in the browser from data already fetched; there is no export endpoint
   * and this does not need one. Fields are quoted and internal quotes doubled per RFC 4180,
   * because a room label like `Sala RM-01 • "Anexo"` or any value containing a comma would
   * otherwise silently corrupt the column alignment.
   */
  function exportCsv() {
    if (filtered.length === 0) return;
    const columns = [
      t("adminEquipment:colName"),
      t("adminEquipment:colBrand"),
      t("adminEquipment:colModel"),
      t("adminEquipment:colSerial"),
      t("equipmentForm:modalityLabel"),
      t("equipmentForm:unitLabel"),
      t("equipmentForm:roomLabel"),
      t("adminEquipment:colStatus"),
    ];
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = filtered.map((item) =>
      [
        item.name,
        item.brand ?? "",
        item.model ?? "",
        item.serialNumber ?? "",
        item.modality ? MODALITY_ABBREVIATION[item.modality] : "",
        unitName(item.unitId),
        item.roomLabel ?? "",
        t(statusLabelKeyOf(displayStatusOf(item))),
      ]
        .map(escape)
        .join(",")
    );
    // The BOM is what makes Excel open a UTF-8 CSV as UTF-8 instead of Latin-1, which is the
    // difference between "Ressonância" and "Ressonância" for every accented value here.
    const csv = `\uFEFF${[columns.map(escape).join(","), ...rows].join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `equipamentos-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <ConsoleShell activeNav="equipment" pageTitle={t("adminEquipment:heading")}>
      <nav aria-label={t("adminEquipment:breadcrumbList")}>
        <ol className="mb-3 flex list-none gap-1.5 p-0 text-sm text-muted-foreground">
          <li>{t("adminEquipment:breadcrumbHome")}</li>
          <li aria-current="page" className="before:mr-1.5 before:content-['/']">
            {t("adminEquipment:breadcrumbList")}
          </li>
        </ol>
      </nav>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mt-0 mb-1 text-xl font-semibold">{t("adminEquipment:heading")}</h1>
          <p className="mt-0 text-muted-foreground">{t("adminEquipment:subheading")}</p>
        </div>
        <Button asChild>
          <Link to="/admin/equipment/new">
            <Plus />
            {t("adminEquipment:newEquipment")}
          </Link>
        </Button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminEquipment:statsTotalLabel")}</div>
            <div className="text-2xl font-semibold">{summary.total}</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("adminEquipment:statsTotalByModality", {
                mri: summary.byModality[ExamModality.MRI],
                ct: summary.byModality[ExamModality.CT],
                ultrasound: summary.byModality[ExamModality.ULTRASOUND],
                xray: summary.byModality[ExamModality.XRAY],
              })}
            </p>
            {summary.unclassified > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">{t("adminEquipment:statsTotalUnclassified", { count: summary.unclassified })}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminEquipment:statsActiveLabel")}</div>
            <div className="text-2xl font-semibold">{summary.active}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("adminEquipment:statsActivePct", { pct: summary.activePct })}</p>
            {summary.degraded > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">{t("adminEquipment:statsDegradedNote", { count: summary.degraded })}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminEquipment:statsMaintenanceLabel")}</div>
            <div className="text-2xl font-semibold">{summary.maintenance}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("adminEquipment:statsMaintenanceNote")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminEquipment:statsInactiveLabel")}</div>
            <div className="text-2xl font-semibold">{summary.inactive}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("adminEquipment:statsInactiveNote")}</p>
            {summary.offline > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">{t("adminEquipment:statsOfflineNote", { count: summary.offline })}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
              <Label htmlFor="eq-search">{t("adminEquipment:searchLabel")}</Label>
              <Input
                id="eq-search"
                type="search"
                value={search}
                placeholder={t("adminEquipment:searchPlaceholder")}
                onChange={(e) => setFilter("q", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eq-filter-status">{t("adminEquipment:filterStatusLabel")}</Label>
              <Select value={statusFilter || ALL} onValueChange={(value) => setFilter("status", value === ALL ? "" : value)}>
                <SelectTrigger id="eq-filter-status" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("adminEquipment:filterStatusAll")}</SelectItem>
                  {STATUS_FILTERS.map((status) => (
                    <SelectItem key={status} value={status}>
                      {t(statusLabelKeyOf(status))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eq-filter-modality">{t("adminEquipment:filterModalityLabel")}</Label>
              <Select value={modalityFilter || ALL} onValueChange={(value) => setFilter("modality", value === ALL ? "" : value)}>
                <SelectTrigger id="eq-filter-modality" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("adminEquipment:filterModalityAll")}</SelectItem>
                  {MODALITY_ORDER.map((modality) => (
                    <SelectItem key={modality} value={modality}>
                      {MODALITY_ABBREVIATION[modality]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eq-filter-unit">{t("adminEquipment:filterUnitLabel")}</Label>
              <Select value={unitFilter || ALL} onValueChange={(value) => setFilter("unit", value === ALL ? "" : value)}>
                <SelectTrigger id="eq-filter-unit" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("adminEquipment:filterUnitAll")}</SelectItem>
                  {units.map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" type="button" onClick={clearFilters}>
                {t("adminEquipment:filterClear")}
              </Button>
              <Button variant="secondary" type="button" onClick={exportCsv} disabled={filtered.length === 0}>
                <Download />
                {t("adminEquipment:export")}
              </Button>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
            {t("adminEquipment:filterResultCount", { filtered: filtered.length, total: summary.total })}
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
                <button className="underline" onClick={() => void load()}>
                  {t("adminEquipment:retry")}
                </button>
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <p aria-live="polite">{t("adminEquipment:loading")}</p>
          ) : equipment.length === 0 ? (
            <p className="text-muted-foreground">{t("adminEquipment:empty")}</p>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground">{t("adminEquipment:emptyFiltered")}</p>
          ) : (
            <>
              <Table>
                <TableCaption className="sr-only">{t("adminEquipment:tableCaption")}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adminEquipment:colName")}</TableHead>
                    <TableHead>{t("adminEquipment:colBrand")}</TableHead>
                    <TableHead>{t("adminEquipment:colModel")}</TableHead>
                    <TableHead>{t("adminEquipment:colSerial")}</TableHead>
                    <TableHead>{t("adminEquipment:colUnitRoom")}</TableHead>
                    <TableHead>{t("adminEquipment:colStatus")}</TableHead>
                    <TableHead>{t("adminEquipment:colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((item) => {
                    const status = displayStatusOf(item);
                    const busy = pendingId === item.id;
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          <div className="font-medium">{item.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {item.modality ? MODALITY_ABBREVIATION[item.modality] : t("adminEquipment:notRecorded")}
                          </div>
                        </TableCell>
                        <TableCell>{item.brand ?? t("adminEquipment:notRecorded")}</TableCell>
                        <TableCell>{item.model ?? t("adminEquipment:notRecorded")}</TableCell>
                        <TableCell>{item.serialNumber ?? t("adminEquipment:notRecorded")}</TableCell>
                        <TableCell>
                          <div>{unitName(item.unitId)}</div>
                          <div className="text-xs text-muted-foreground">{item.roomLabel ?? t("adminEquipment:noRoom")}</div>
                        </TableCell>
                        <TableCell>
                          <Badge className={cn("border-transparent", tailwindBadgeClassOf(status))}>{t(statusLabelKeyOf(status))}</Badge>
                          {/* A retired device's health reading is frozen (the poller skips it),
                              so the last value observed is shown as secondary text rather than
                              as the pill itself, which would claim it is current. */}
                          {status === "inactive" && (
                            <div className="text-xs text-muted-foreground">{t("adminEquipment:statusInactiveFrozenHint", { status: item.status })}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1.5">
                            <Button variant="secondary" size="sm" asChild>
                              <Link to={`/admin/equipment/${item.id}`}>{t("adminEquipment:actionView")}</Link>
                            </Button>
                            <Button variant="secondary" size="sm" asChild>
                              <Link to={`/admin/equipment/${item.id}/edit`}>{t("adminEquipment:actionEdit")}</Link>
                            </Button>
                            {item.deactivated ? (
                              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void runAction(item, "reactivate")}>
                                {t("adminEquipment:actionReactivate")}
                              </Button>
                            ) : (
                              <>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    void runAction(item, item.status === EquipmentStatus.MAINTENANCE ? "maintenance/clear" : "maintenance")
                                  }
                                >
                                  {item.status === EquipmentStatus.MAINTENANCE
                                    ? t("adminEquipment:actionClearMaintenance")
                                    : t("adminEquipment:actionEnterMaintenance")}
                                </Button>
                                <Button variant="destructive" size="sm" disabled={busy} onClick={() => setConfirmingDeactivation(item)}>
                                  {t("adminEquipment:actionDeactivate")}
                                </Button>
                              </>
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
                  <Label htmlFor="eq-page-size">{t("adminEquipment:pageSizeLabel")}</Label>
                  <Select value={String(pageSize)} onValueChange={(value) => setFilter("size", value)}>
                    <SelectTrigger id="eq-page-size" className="w-20">
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
                  {t("adminEquipment:paginationSummary", {
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
                    aria-label={t("adminEquipment:paginationPrev")}
                  >
                    <ChevronLeft />
                  </Button>
                  {Array.from({ length: pageCount }, (_unused, index) => index + 1).map((pageNumber) => (
                    <Button
                      key={pageNumber}
                      variant="secondary"
                      size="icon-sm"
                      aria-current={pageNumber === currentPage ? "page" : undefined}
                      aria-label={t("adminEquipment:paginationPage", { page: pageNumber })}
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
                    aria-label={t("adminEquipment:paginationNext")}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Deactivation is confirmed, unlike maintenance: maintenance is trivially reversible
          and self-evident, whereas "desativar" next to a trash-can-shaped intent deserves a
          sentence stating what actually happens (and, as importantly, what does not -- an
          in-flight session is not killed). */}
      {confirmingDeactivation && (
        <Modal title={t("adminEquipment:confirmDeactivateTitle")} onClose={() => setConfirmingDeactivation(null)}>
          <p>{t("adminEquipment:confirmDeactivateBody", { name: confirmingDeactivation.name })}</p>
          <div className="mt-4 flex justify-end gap-2.5">
            <Button variant="outline" onClick={() => setConfirmingDeactivation(null)}>
              {t("adminEquipment:confirmCancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={pendingId === confirmingDeactivation.id}
              onClick={() => void runAction(confirmingDeactivation, "deactivate")}
            >
              {t("adminEquipment:confirmDeactivateConfirm")}
            </Button>
          </div>
        </Modal>
      )}
    </ConsoleShell>
  );
}
