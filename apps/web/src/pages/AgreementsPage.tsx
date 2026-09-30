import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AgreementStatus,
  type EquipmentDto,
  type MyClinic,
  type OperatorAgreementDto,
  type TenantDto,
  type UnitDto,
} from "@crop/shared";
import { Plus } from "lucide-react";
import { cn } from "cn";
import { api, ApiError } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { Modal } from "../components/Modal.js";
import { CheckboxCardGroup } from "../components/CheckboxCardGroup.js";
import { Button } from "../components/ui/button.js";
import { Label } from "../components/ui/label.js";
import { Badge } from "../components/ui/badge.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { Card, CardContent } from "../components/ui/card.js";
import { tailwindBadgeClassOf, type DisplayStatus } from "../lib/equipment-display.js";
import { agreementStatusBadgeClassOf, agreementStatusLabelKeyOf, counterpartyOf, isActionableBy } from "../lib/agreement-display.js";

const ALL = "__all__";

/**
 * Clinic <-> operating-company contracts. One screen serving both sides of the relationship, because
 * it is one relationship: a clinic manages "which companies may operate our rooms", an operating
 * company manages "which clinics we are engaged by", and every action available differs only by
 * which side the viewer is on.
 *
 * The alternative -- two pages -- would have duplicated the whole list, the status vocabulary and
 * the propose flow to express a difference the API itself does not make (`GET /agreements` answers
 * from either direction; see `ListAgreementsHandler`).
 *
 * All fetching is `useEffect` + `api.get`/`api.post` with local `loading`/`error` state; there is no
 * react-query in this codebase (same convention as `NursingPage`). Filter state is not in the URL
 * here, unlike the admin listing pages: this screen has one filter with four values and no
 * pagination, so there is nothing a shareable link would usefully carry.
 *
 * Rebuilt on shadcn/ui alongside the other admin pages -- `agreementStatusBadgeClassOf`'s own
 * "online"/"offline"/"degraded"/"inactive" vocabulary maps directly onto
 * `tailwindBadgeClassOf` (see equipment-display.ts), so no new color mapping was needed here.
 * `CheckboxCardGroup` inside the scope modal was migrated separately, batched with the form
 * pages in a later phase -- `Modal`'s own `.theme-light` wrapper (since removed, once every
 * caller's content was migrated too -- see its own docstring) is what made it safe to defer
 * at the time: it rendered the old, unmigrated component correctly in the meantime.
 *
 * Not reproduced, deliberately:
 *
 * | Wanted | Why not |
 * |---|---|
 * | Emailing the counterparty when a contract is proposed | `MailerPort` exists, but a clinic's `institutionalEmail` is nullable and there is no "contracts" recipient role -- the pending agreement showing up in this list *is* the notification, and inventing a delivery target would mean silently dropping half of them |
 * | An accept-by-link flow for someone without an account | Accepting changes who may reach patient data, so it has to be an authenticated, audited act by a named admin; a link would either bypass that or require the account it was meant to avoid |
 * | Editing scope on a PENDING proposal from the operator side | Scope is the clinic's to set (`assertScopeCanBeSetBy`); an operator "requesting" rooms would be a different feature with its own negotiation, not a variation of this one |
 */
export default function AgreementsPage() {
  const { t } = useTranslation(["agreements"]);
  const { user } = useAuth();

  const [agreements, setAgreements] = useState<OperatorAgreementDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<AgreementStatus | "ALL">("ALL");

  // A clinic-side admin proposes to a company and vice versa, so the picker's contents depend on
  // which side the viewer is. `GET /tenants` is PLATFORM_ADMIN-only, so a clinic admin cannot list
  // operating companies -- which is why proposing is offered to the operator side and to a platform
  // admin, and a clinic's own route into a contract is accepting one. Documented rather than
  // papered over with a fake picker.
  const isPlatformAdmin = user?.role === "PLATFORM_ADMIN";
  const isOperatorSide = user?.role === "OPERATOR_ADMIN";

  const [proposeOpen, setProposeOpen] = useState(false);
  const [counterpartyOptions, setCounterpartyOptions] = useState<{ id: string; name: string }[]>([]);
  const [proposeTarget, setProposeTarget] = useState("");
  const [proposing, setProposing] = useState(false);

  const [scopeFor, setScopeFor] = useState<OperatorAgreementDto | null>(null);
  const [scopeUnits, setScopeUnits] = useState<UnitDto[]>([]);
  const [scopeEquipment, setScopeEquipment] = useState<EquipmentDto[]>([]);
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [savingScope, setSavingScope] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      setAgreements(await api.get<OperatorAgreementDto[]>("/agreements"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("agreements:loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  // Only fetched when the modal opens: a clinic admin cannot call `GET /tenants` at all, so doing it
  // eagerly would put a guaranteed 403 in the console on every visit for the role that uses this
  // page most.
  async function openPropose() {
    setActionError(null);
    setProposeTarget("");
    setProposeOpen(true);
    try {
      if (isPlatformAdmin || isOperatorSide) {
        const tenants = await api.get<TenantDto[]>("/tenants");
        const wanted = isOperatorSide ? "CLINIC" : "OPERATOR_PROVIDER";
        setCounterpartyOptions(
          tenants.filter((tenant) => tenant.type === wanted && !tenant.deactivated).map((tenant) => ({ id: tenant.id, name: tenant.name }))
        );
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("agreements:counterpartyLoadFailed"));
    }
  }

  async function submitPropose() {
    if (!proposeTarget) return;
    setProposing(true);
    setActionError(null);
    try {
      // Which field names the counterparty depends on the viewer's own side; the server derives the
      // clinic/operator roles from tenant *types* regardless, so this only has to be self-consistent.
      await api.post("/agreements", isOperatorSide ? { clinicTenantId: proposeTarget } : { operatorTenantId: proposeTarget });
      setProposeOpen(false);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("agreements:proposeFailed"));
    } finally {
      setProposing(false);
    }
  }

  async function act(agreement: OperatorAgreementDto, action: "accept" | "reject" | "revoke") {
    setPendingId(agreement.id);
    setActionError(null);
    try {
      await api.post(`/agreements/${agreement.id}/${action}`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("agreements:actionFailed"));
    } finally {
      setPendingId(null);
    }
  }

  async function openScope(agreement: OperatorAgreementDto) {
    setScopeFor(agreement);
    setActionError(null);
    setSelectedUnitIds(agreement.scopes.filter((scope) => scope.unitId).map((scope) => scope.unitId!));
    try {
      const [units, equipment] = await Promise.all([
        api.get<UnitDto[]>(`/units?clinicTenantId=${agreement.clinicTenantId}`),
        api.get<EquipmentDto[]>("/equipment"),
      ]);
      setScopeUnits(units.filter((unit) => !unit.deactivated));
      setScopeEquipment(equipment);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("agreements:scopeLoadFailed"));
    }
  }

  async function saveScope() {
    if (!scopeFor) return;
    setSavingScope(true);
    setActionError(null);
    try {
      // Units only from this screen. Per-equipment grants exist in the model and are honoured by
      // the API, but offering both here would ask a clinic admin to reason about two overlapping
      // granularities in one form -- and a unit grant is the one that keeps covering rooms as
      // scanners are replaced, which is what a clinic almost always means.
      await api.put(`/agreements/${scopeFor.id}/scope`, { unitIds: selectedUnitIds, equipmentIds: [] });
      setScopeFor(null);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("agreements:scopeSaveFailed"));
    } finally {
      setSavingScope(false);
    }
  }

  const visible = useMemo(
    () => (statusFilter === "ALL" ? agreements : agreements.filter((agreement) => agreement.status === statusFilter)),
    [agreements, statusFilter]
  );

  const equipmentCountByUnit = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of scopeEquipment) {
      if (item.unitId) counts.set(item.unitId, (counts.get(item.unitId) ?? 0) + 1);
    }
    return counts;
  }, [scopeEquipment]);

  return (
    <ConsoleShell activeNav="agreements" pageTitle={t("agreements:pageTitle")}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mt-0 mb-1 text-xl font-semibold">{t("agreements:heading")}</h1>
          <p className="text-muted-foreground">{isOperatorSide ? t("agreements:subtitleOperator") : t("agreements:subtitleClinic")}</p>
        </div>
        {(isOperatorSide || isPlatformAdmin) && (
          <Button onClick={openPropose}>
            <Plus />
            {t("agreements:propose")}
          </Button>
        )}
      </div>

      {actionError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Card className="mb-4">
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agreement-status">{t("agreements:filterStatus")}</Label>
              <Select
                value={statusFilter === "ALL" ? ALL : statusFilter}
                onValueChange={(value) => setStatusFilter(value === ALL ? "ALL" : (value as AgreementStatus))}
              >
                <SelectTrigger id="agreement-status" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("agreements:statusAll")}</SelectItem>
                  {Object.values(AgreementStatus).map((status) => (
                    <SelectItem key={status} value={status}>
                      {t(agreementStatusLabelKeyOf(status))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
            {t("agreements:resultCount", { count: visible.length })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {loading ? (
            <p aria-live="polite">{t("agreements:loading")}</p>
          ) : loadError ? (
            <Alert variant="destructive">
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("agreements:empty")}</p>
          ) : (
            <Table>
              <TableCaption className="sr-only">{t("agreements:tableCaption")}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{isOperatorSide ? t("agreements:colClinic") : t("agreements:colOperator")}</TableHead>
                  <TableHead>{t("agreements:colStatus")}</TableHead>
                  <TableHead>{t("agreements:colScope")}</TableHead>
                  <TableHead>{t("agreements:colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((agreement) => {
                  const ownTenantId = isOperatorSide ? agreement.operatorTenantId : agreement.clinicTenantId;
                  const isClinicSide = !isOperatorSide;
                  const canRespond = isActionableBy(agreement, ownTenantId);
                  return (
                    <TableRow key={agreement.id}>
                      <TableCell>
                        <div className="font-medium">{counterpartyOf(agreement, isOperatorSide)}</div>
                        <div className="text-xs text-muted-foreground">{new Date(agreement.createdAt).toLocaleDateString("pt-BR")}</div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={cn("border-transparent", tailwindBadgeClassOf(agreementStatusBadgeClassOf(agreement.status) as DisplayStatus))}
                        >
                          {t(agreementStatusLabelKeyOf(agreement.status))}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {agreement.scopes.length === 0 ? (
                          // Not decorative: an ACTIVE agreement with no scope genuinely grants nothing,
                          // and that is the single most confusing state this feature can be in, so it
                          // is called out rather than shown as an empty cell.
                          <span className="text-xs text-muted-foreground">{t("agreements:scopeEmpty")}</span>
                        ) : (
                          <div className="text-xs text-muted-foreground">{agreement.scopes.map((scope) => scope.label).join(" · ")}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          {canRespond && (
                            <>
                              <Button size="sm" disabled={pendingId === agreement.id} onClick={() => void act(agreement, "accept")}>
                                {t("agreements:accept")}
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={pendingId === agreement.id}
                                onClick={() => void act(agreement, "reject")}
                              >
                                {t("agreements:reject")}
                              </Button>
                            </>
                          )}
                          {isClinicSide && agreement.status !== "REJECTED" && agreement.status !== "REVOKED" && (
                            <Button variant="secondary" size="sm" onClick={() => void openScope(agreement)}>
                              {t("agreements:editScope")}
                            </Button>
                          )}
                          {agreement.status === "ACTIVE" && (
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={pendingId === agreement.id}
                              onClick={() => void act(agreement, "revoke")}
                            >
                              {t("agreements:revoke")}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {proposeOpen && (
        <Modal title={t("agreements:proposeTitle")} onClose={() => setProposeOpen(false)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="propose-counterparty">{isOperatorSide ? t("agreements:pickClinic") : t("agreements:pickOperator")}</Label>
            <Select value={proposeTarget} onValueChange={setProposeTarget}>
              <SelectTrigger id="propose-counterparty" className="w-full">
                <SelectValue placeholder={t("agreements:pickPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {counterpartyOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("agreements:proposeHint")}</p>
          </div>
          <div className="mt-4 flex justify-end gap-2.5">
            <Button disabled={!proposeTarget || proposing} onClick={() => void submitPropose()}>
              {proposing ? t("agreements:saving") : t("agreements:proposeSubmit")}
            </Button>
            <Button variant="outline" onClick={() => setProposeOpen(false)}>
              {t("agreements:cancel")}
            </Button>
          </div>
        </Modal>
      )}

      {scopeFor && (
        <Modal title={t("agreements:scopeTitle", { name: counterpartyOf(scopeFor, isOperatorSide) })} onClose={() => setScopeFor(null)}>
          <p className="text-sm text-muted-foreground">{t("agreements:scopeHint")}</p>
          {scopeUnits.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("agreements:scopeNoUnits")}</p>
          ) : (
            <CheckboxCardGroup
              legend={t("agreements:scopeLegend")}
              name="agreement-scope-units"
              value={selectedUnitIds}
              onChange={setSelectedUnitIds}
              options={scopeUnits.map((unit) => ({
                value: unit.id,
                title: unit.name,
                hint: t("agreements:scopeUnitHint", { count: equipmentCountByUnit.get(unit.id) ?? 0 }),
              }))}
            />
          )}
          <div className="mt-4 flex justify-end gap-2.5">
            <Button disabled={savingScope} onClick={() => void saveScope()}>
              {savingScope ? t("agreements:saving") : t("agreements:scopeSubmit")}
            </Button>
            <Button variant="outline" onClick={() => setScopeFor(null)}>
              {t("agreements:cancel")}
            </Button>
          </div>
        </Modal>
      )}
    </ConsoleShell>
  );
}
