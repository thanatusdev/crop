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
import { formatTenantCityState, formatTenantCnpj, summarizeOperators } from "../lib/tenant-display.js";

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
/** See `AdminEquipmentPage`'s own comment on this sentinel. */
const ALL = "__all__";

/**
 * Operadora registry -- the `OPERATOR_PROVIDER` counterpart to `AdminClinicsPage`, same
 * shape (stat cards, search/status filter, CSV export, pagination, deactivate/reactivate
 * with a confirm dialog). Two differences, both because an operadora is a staff directory
 * with contracts, not a clinical site with equipment:
 *
 * - **Fetches `GET /tenants?type=OPERATOR_PROVIDER` server-side** rather than fetching
 *   every tenant and filtering to one type client-side the way `AdminClinicsPage` still
 *   does (see that page's own docstring on why it predates the filter) -- this page was
 *   written after `ListTenantsQuery` grew a `type` filter, so there was no reason to repeat
 *   the over-fetch.
 * - **No modality column/filter.** An operadora owns no `Equipment` of its own (see
 *   `TenantSchema`'s own docstring); its two meaningful metrics are
 *   `activeAgreementCount`/`userCount` instead of `equipmentCount`/`modalities`.
 */
export default function AdminOperatorsPage() {
  const { t } = useTranslation(["adminOperators"]);

  const [operators, setOperators] = useState<TenantDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmingDeactivation, setConfirmingDeactivation] = useState<TenantDto | null>(null);

  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const statusFilter = params.get("status") ?? "";
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
    void loadOperators();
  }, []);

  async function loadOperators() {
    setLoading(true);
    setLoadError(null);
    try {
      setOperators(await api.get<TenantDto[]>("/tenants?type=OPERATOR_PROVIDER"));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t("adminOperators:loadError"));
    } finally {
      setLoading(false);
    }
  }

  const summary = useMemo(() => summarizeOperators(operators), [operators]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return operators.filter((operator) => {
      if (statusFilter === "active" && operator.deactivated) return false;
      if (statusFilter === "inactive" && !operator.deactivated) return false;
      if (!needle) return true;
      return [operator.name, operator.cnpj, operator.institutionalEmail].some((field) => field?.toLowerCase().includes(needle));
    });
  }, [operators, search, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const visible = filtered.slice(pageStart, pageStart + pageSize);

  async function runAction(operator: TenantDto, path: string) {
    setActionError(null);
    setPendingId(operator.id);
    try {
      await api.post(`/tenants/${operator.id}/${path}`);
      await loadOperators();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("adminOperators:genericActionError"));
    } finally {
      setPendingId(null);
      setConfirmingDeactivation(null);
    }
  }

  function exportCsv() {
    if (filtered.length === 0) return;
    const columns = [
      t("adminOperators:colName"),
      t("adminOperators:colCnpj"),
      t("adminOperators:colAddress"),
      t("adminOperators:colAgreements"),
      t("adminOperators:colUsers"),
      t("adminOperators:colStatus"),
    ];
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = filtered.map((operator) =>
      [
        operator.name,
        formatTenantCnpj(operator) ?? "",
        formatTenantCityState(operator) ?? "",
        String(operator.activeAgreementCount),
        String(operator.userCount),
        operator.deactivated ? t("adminOperators:statusInactive") : t("adminOperators:statusActive"),
      ]
        .map(escape)
        .join(",")
    );
    const csv = `\uFEFF${[columns.map(escape).join(","), ...rows].join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `operadoras-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <ConsoleShell activeNav="operators" pageTitle={t("adminOperators:heading")}>
      <nav aria-label={t("adminOperators:breadcrumbList")}>
        <ol className="mb-3 flex list-none gap-1.5 p-0 text-sm text-muted-foreground">
          <li>{t("adminOperators:breadcrumbHome")}</li>
          <li aria-current="page" className="before:mr-1.5 before:content-['/']">
            {t("adminOperators:breadcrumbList")}
          </li>
        </ol>
      </nav>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mt-0 mb-1 text-xl font-semibold">{t("adminOperators:heading")}</h1>
          <p className="mt-0 text-muted-foreground">{t("adminOperators:subheading")}</p>
        </div>
        <Button asChild>
          <Link to="/superadmin/operadoras/new">
            <Plus />
            {t("adminOperators:newOperator")}
          </Link>
        </Button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminOperators:statsTotalLabel")}</div>
            <div className="text-2xl font-semibold">{summary.total}</div>
            {summary.newThisMonth > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">{t("adminOperators:statsTotalNew", { count: summary.newThisMonth })}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminOperators:statsActiveLabel")}</div>
            <div className="text-2xl font-semibold">{summary.active}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("adminOperators:statsActivePct", { pct: summary.activePct })}</p>
            {summary.inactive > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">{t("adminOperators:statsActiveNote", { count: summary.inactive })}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminOperators:statsAgreementsLabel")}</div>
            <div className="text-2xl font-semibold">{summary.totalActiveAgreements}</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("adminOperators:statsAgreementsNote", { count: summary.withActiveAgreement })}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-muted-foreground">{t("adminOperators:statsUsersLabel")}</div>
            <div className="text-2xl font-semibold">{summary.totalUsers}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("adminOperators:statsUsersNote")}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
              <Label htmlFor="operator-search">{t("adminOperators:searchLabel")}</Label>
              <Input
                id="operator-search"
                type="search"
                value={search}
                placeholder={t("adminOperators:searchPlaceholder")}
                onChange={(e) => setFilter("q", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="operator-filter-status">{t("adminOperators:filterStatusLabel")}</Label>
              <Select value={statusFilter || ALL} onValueChange={(value) => setFilter("status", value === ALL ? "" : value)}>
                <SelectTrigger id="operator-filter-status" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("adminOperators:filterStatusAll")}</SelectItem>
                  <SelectItem value="active">{t("adminOperators:statusActive")}</SelectItem>
                  <SelectItem value="inactive">{t("adminOperators:statusInactive")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" type="button" onClick={clearFilters}>
                {t("adminOperators:filterClear")}
              </Button>
              <Button variant="secondary" type="button" onClick={exportCsv} disabled={filtered.length === 0}>
                <Download />
                {t("adminOperators:export")}
              </Button>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
            {t("adminOperators:filterResultCount", { filtered: filtered.length, total: summary.total })}
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
                <button className="underline" onClick={() => void loadOperators()}>
                  {t("adminOperators:retry")}
                </button>
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <p aria-live="polite">{t("adminOperators:loading")}</p>
          ) : operators.length === 0 ? (
            <p className="text-muted-foreground">{t("adminOperators:empty")}</p>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground">{t("adminOperators:emptyFiltered")}</p>
          ) : (
            <>
              <Table>
                <TableCaption className="sr-only">{t("adminOperators:tableCaption")}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adminOperators:colName")}</TableHead>
                    <TableHead>{t("adminOperators:colCnpj")}</TableHead>
                    <TableHead>{t("adminOperators:colAddress")}</TableHead>
                    <TableHead>{t("adminOperators:colAgreements")}</TableHead>
                    <TableHead>{t("adminOperators:colUsers")}</TableHead>
                    <TableHead>{t("adminOperators:colStatus")}</TableHead>
                    <TableHead>{t("adminOperators:colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((operator) => {
                    const busy = pendingId === operator.id;
                    const cityState = formatTenantCityState(operator);
                    return (
                      <TableRow key={operator.id}>
                        <TableCell>
                          <div className="font-medium">{operator.name}</div>
                        </TableCell>
                        <TableCell>{formatTenantCnpj(operator) ?? t("adminOperators:notRecorded")}</TableCell>
                        <TableCell>{cityState ?? t("adminOperators:notRecorded")}</TableCell>
                        <TableCell>{operator.activeAgreementCount}</TableCell>
                        <TableCell>{operator.userCount}</TableCell>
                        <TableCell>
                          <Badge
                            className={cn(
                              "border-transparent",
                              operator.deactivated ? "bg-[#3d1d1d] text-[#ff8b8b]" : "bg-[#1d3d2b] text-[#5fdc8a]"
                            )}
                          >
                            {operator.deactivated ? t("adminOperators:statusInactive") : t("adminOperators:statusActive")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="secondary" size="icon-sm" aria-label={t("adminOperators:actionView")} asChild>
                                  <Link to={`/superadmin/operadoras/${operator.id}`}>
                                    <Eye />
                                  </Link>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t("adminOperators:actionView")}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="secondary" size="icon-sm" aria-label={t("adminOperators:actionEdit")} asChild>
                                  <Link to={`/superadmin/operadoras/${operator.id}/edit`}>
                                    <Pencil />
                                  </Link>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t("adminOperators:actionEdit")}</TooltipContent>
                            </Tooltip>
                            {operator.deactivated ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="secondary"
                                    size="icon-sm"
                                    aria-label={t("adminOperators:actionReactivate")}
                                    disabled={busy}
                                    onClick={() => void runAction(operator, "reactivate")}
                                  >
                                    <RotateCcw />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t("adminOperators:actionReactivate")}</TooltipContent>
                              </Tooltip>
                            ) : (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="destructive"
                                    size="icon-sm"
                                    aria-label={t("adminOperators:actionDeactivate")}
                                    disabled={busy}
                                    onClick={() => setConfirmingDeactivation(operator)}
                                  >
                                    <Ban />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t("adminOperators:actionDeactivate")}</TooltipContent>
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
                  <Label htmlFor="operator-page-size">{t("adminOperators:pageSizeLabel")}</Label>
                  <Select value={String(pageSize)} onValueChange={(value) => setFilter("size", value)}>
                    <SelectTrigger id="operator-page-size" className="w-20">
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
                  {t("adminOperators:paginationSummary", {
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
                    aria-label={t("adminOperators:paginationPrev")}
                  >
                    <ChevronLeft />
                  </Button>
                  {Array.from({ length: pageCount }, (_unused, index) => index + 1).map((pageNumber) => (
                    <Button
                      key={pageNumber}
                      variant="secondary"
                      size="icon-sm"
                      aria-current={pageNumber === currentPage ? "page" : undefined}
                      aria-label={t("adminOperators:paginationPage", { page: pageNumber })}
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
                    aria-label={t("adminOperators:paginationNext")}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Deactivation is confirmed, and the message names how many active agreements would
          be left dangling -- same pattern, and same reasoning, as the clinic registry's own
          dialog (which names equipment/unit counts instead). */}
      {confirmingDeactivation && (
        <Modal title={t("adminOperators:confirmDeactivateTitle")} onClose={() => setConfirmingDeactivation(null)}>
          <p>
            {confirmingDeactivation.activeAgreementCount > 0
              ? t("adminOperators:confirmDeactivateBodyWithAgreements", {
                  name: confirmingDeactivation.name,
                  count: confirmingDeactivation.activeAgreementCount,
                })
              : t("adminOperators:confirmDeactivateBodyNoAgreements", { name: confirmingDeactivation.name })}
          </p>
          <div className="mt-4 flex justify-end gap-2.5">
            <Button variant="outline" onClick={() => setConfirmingDeactivation(null)}>
              {t("adminOperators:confirmCancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={pendingId === confirmingDeactivation.id}
              onClick={() => void runAction(confirmingDeactivation, "deactivate")}
            >
              {t("adminOperators:confirmDeactivateConfirm")}
            </Button>
          </div>
        </Modal>
      )}
    </ConsoleShell>
  );
}
