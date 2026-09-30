import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  RT_EVENTS,
  todayClinicDayString,
  type EquipmentDto,
  type MeResponse,
  type MyClinic,
  type QueueEntryDto,
  type UnitDto,
} from "@crop/shared";
import { api } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { createSessionSocket } from "../lib/socket-client.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { IdentityCard } from "../components/IdentityCard.js";
import { RolePermissionSummary } from "../components/RolePermissionSummary.js";
import { Button } from "../components/ui/button.js";
import { Label } from "../components/ui/label.js";
import { Badge } from "../components/ui/badge.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { cn } from "cn";
import { MODALITY_ABBREVIATION, displayStatusOf, statusLabelKeyOf, tailwindBadgeClassOf } from "../lib/equipment-display.js";

// Radix `Select.Item` rejects an empty-string `value` -- stands in for "nothing chosen yet"
// in the three dependent pickers below, mapped to/from `""` at the read/write boundary, same
// convention as every other migrated page's own sentinel.
const NONE = "__none__";

/**
 * The Biomédico Operador's post-login landing screen (`OPERATOR` only -- see `role-routes.ts`
 * and this route's `RoleRoute` in `App.tsx`): pick the clinic, unit, and room ("posto de
 * trabalho") for the shift, then confirm into that room's real exam surface. Built from a
 * "Selecione seu Perfil e Posto de Trabalho" RadLink mock; see the `workstation` namespace's
 * own docstring in `pt-BR.ts` for the exhaustive "reproduced vs. deliberately not" table
 * against that mock.
 *
 * **The clinic step is new, and it is never skippable for this role.** Since the role-model
 * inversion (see `packages/shared/src/roles.ts`), `OPERATOR` belongs to an OPERATOR_PROVIDER
 * tenant, which owns no clinic of its own -- there is no "default clinic" for this page to
 * fall back to the way `NursingPage` falls back to the caller's own home tenant. Rule: "the
 * operator should always select the clinic and unit to see the equipment." The clinic list is
 * `GET /auth/me/clinics`, which -- since the `OperatorAgreement` model landed -- already
 * includes every clinic the operator's own company holds a live contract with; picking one
 * calls `POST /auth/active-clinic` (`useAuth().switchActiveClinic`) to actually enter that
 * clinic's context before `GET /units`/`GET /equipment` are called at all, since both of those
 * operate on `user.tenantId` with no clinic parameter of their own.
 *
 * Three things worth knowing that aren't obvious from the mock:
 *
 *  1. **There is no `Room` model.** A "room" is `Equipment.roomLabel` -- the same
 *     equipment-as-room convention `NursingPage` already established. The room dropdown is
 *     therefore `GET /equipment` filtered to the chosen unit's `unitId`, not a separate
 *     endpoint. Both `GET /units` and `GET /equipment` are open to any authenticated role,
 *     scoped inside each handler -- `ClinicAccessChecker`/`OperatorAccessService` are what
 *     decide whether this operator's *currently active* clinic (post-switch) is one they may
 *     actually see, and further narrow the equipment list to what their company's agreement
 *     scope covers.
 *  2. **The profile card is read-only.** Role comes from the JWT, never a user choice (every
 *     controller's own `@Roles` would reject a role the account doesn't actually have) --
 *     `IdentityCard`/`RolePermissionSummary` are the same two components the password-reset
 *     screens already use for "who is this and what can they do." `GET /auth/me`'s own
 *     `tenantId` is the account's *home* tenant (the real `User.tenantId` column, not the
 *     JWT's active/switched one -- see `GetMeHandler`), so this card is unaffected by any
 *     clinic switch below it and needed no changes here.
 *
 * Selection lives in the URL (`?clinicTenantId=&unitId=&equipmentId=`), the same convention
 * `NursingPage`/`AdminEquipmentPage` use for their own filters -- picking a clinic clears any
 * previously chosen unit/room, and picking a unit clears any previously chosen room, since
 * either is never a valid combination once its parent changes. Returning here (e.g. via
 * `DashboardPage`'s "Trocar posto de trabalho" link, or a mid-shift reload) seeds the clinic
 * step from whichever clinic the stored token is already scoped to, rather than forcing a
 * re-pick of a clinic the operator never actually left.
 *
 * Confirm navigates to `/exame?equipmentId=…` -- the dedicated exam cockpit (see its own
 * docstring). Before that screen existed, this pointed at `/?equipmentId=…`
 * (`DashboardPage` in "scoped" mode) as the honest interim destination; that page's scoped
 * mode is untouched and still reachable by every other role's own "Start/Rejoin session"
 * button, only this one navigation call changed.
 */
export default function WorkstationPage() {
  const { t } = useTranslation(["workstation", "adminEquipment", "roles", "permissions"]);
  const navigate = useNavigate();
  const { user, switchActiveClinic } = useAuth();
  const [params, setParams] = useSearchParams();
  const selectedClinicId = params.get("clinicTenantId") ?? "";
  const selectedUnitId = params.get("unitId") ?? "";
  const selectedEquipmentId = params.get("equipmentId") ?? "";
  const today = useMemo(() => todayClinicDayString(), []);

  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => {
    void api
      .get<MeResponse>("/auth/me")
      .then(setMe)
      .catch(() => {
        // Non-fatal, decorative only -- the profile card just doesn't render, same
        // "best-effort" reasoning as ConsoleShell's own health-pill fetch.
      });
  }, []);

  const [clinics, setClinics] = useState<MyClinic[]>([]);
  const [clinicsLoading, setClinicsLoading] = useState(true);
  const [clinicsError, setClinicsError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  // Whether the token's *current* active tenant is the clinic this page shows as selected --
  // i.e. GET /units and GET /equipment would actually return that clinic's data right now.
  // Recomputed fresh every render from `user`, never cached, so it flips the instant
  // `switchActiveClinic` resolves without this component having to sequence anything itself.
  const isActiveClinic = !!selectedClinicId && user?.tenantId === selectedClinicId;

  const [units, setUnits] = useState<UnitDto[]>([]);
  const [unitsError, setUnitsError] = useState<string | null>(null);
  const [equipment, setEquipment] = useState<EquipmentDto[]>([]);
  const [equipmentError, setEquipmentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function setClinicParam(clinicTenantId: string, opts: { clearDownstream: boolean } = { clearDownstream: true }) {
    const next = new URLSearchParams(params);
    if (clinicTenantId) next.set("clinicTenantId", clinicTenantId);
    else next.delete("clinicTenantId");
    if (opts.clearDownstream) {
      // A unit/room from a previous clinic is never valid once the clinic itself changes.
      next.delete("unitId");
      next.delete("equipmentId");
    }
    setParams(next, { replace: true });
  }

  useEffect(() => {
    void loadClinics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadClinics() {
    setClinicsLoading(true);
    setClinicsError(null);
    try {
      const list = (await api.get<MyClinic[]>("/auth/me/clinics")).filter((c) => !c.deactivated).sort((a, b) => a.name.localeCompare(b.name));
      setClinics(list);
      if (!params.get("clinicTenantId")) {
        // Seed from whichever clinic the stored token is already scoped to, not an empty
        // pick -- a mid-shift reload, or arriving via DashboardPage's "Trocar posto de
        // trabalho" link, should not force re-selecting a clinic never actually left.
        // `clearDownstream: false`: the unit/room in the URL are still valid for that clinic.
        const current = list.find((c) => c.active);
        if (current) setClinicParam(current.id, { clearDownstream: false });
      }
    } catch (err) {
      setClinicsError(err instanceof Error ? err.message : t("workstation:clinicLoadError"));
    } finally {
      setClinicsLoading(false);
    }
  }

  // Performs the actual switch whenever the selected clinic isn't the token's active one yet
  // -- both the first real pick, and picking a *different* clinic after already having one
  // active. Deliberately does not itself trigger the units/equipment fetch below: `user`
  // updating (inside `switchActiveClinic`) is what flips `isActiveClinic`, and that is its
  // own effect's dependency -- keeping "mint a token" and "load this clinic's rooms" as
  // separate steps, the same separation `useAuth`'s own docstring calls out.
  useEffect(() => {
    if (!selectedClinicId || isActiveClinic) return;
    let cancelled = false;
    setSwitching(true);
    setSwitchError(null);
    switchActiveClinic(selectedClinicId)
      .catch((err) => {
        if (!cancelled) setSwitchError(err instanceof Error ? err.message : t("workstation:clinicSwitchError"));
      })
      .finally(() => {
        if (!cancelled) setSwitching(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClinicId]);

  useEffect(() => {
    if (!isActiveClinic) {
      setUnits([]);
      setEquipment([]);
      return;
    }
    void loadRooms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActiveClinic]);

  async function loadRooms() {
    setLoading(true);
    setUnitsError(null);
    setEquipmentError(null);
    try {
      const [unitList, equipmentList] = await Promise.all([
        api.get<UnitDto[]>("/units"),
        api.get<EquipmentDto[]>("/equipment"),
      ]);
      setUnits(unitList.filter((u) => !u.deactivated).sort((a, b) => a.name.localeCompare(b.name)));
      setEquipment(equipmentList.filter((e) => !e.deactivated));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("workstation:unitLoadError");
      setUnitsError(message);
      setEquipmentError(message);
    } finally {
      setLoading(false);
    }
  }

  // Live push: the health poller flipping this equipment's status, or another user changing
  // its room's queue, would otherwise only show up here after a manual reload -- same
  // reasoning as DashboardPage's own identical subscription. Reconnected on every clinic
  // switch (keyed on `user?.tenantId`, not mounted once): `createSessionSocket()` snapshots
  // the access token at connect time, and `SessionsGateway.handleConnection` joins the socket
  // to *that* token's tenant room once, for the life of the connection -- a socket opened
  // before a switch would keep listening to the operator's own (equipment-less) provider
  // tenant forever, deaf to every update from the clinic actually being worked in.
  useEffect(() => {
    if (!isActiveClinic) return;
    const sock = createSessionSocket();
    sock.connect();
    sock.on(RT_EVENTS.EQUIPMENT_STATUS_CHANGED, () => void loadRooms());
    return () => {
      sock.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActiveClinic, user?.tenantId]);

  const roomsForUnit = useMemo(
    () => equipment.filter((e) => e.unitId === selectedUnitId).sort((a, b) => a.name.localeCompare(b.name)),
    [equipment, selectedUnitId]
  );
  const selectedEquipment = equipment.find((e) => e.id === selectedEquipmentId) ?? null;

  function roomOptionLabel(item: EquipmentDto): string {
    const parts = [
      item.roomLabel ?? item.name,
      item.modality ? MODALITY_ABBREVIATION[item.modality] : null,
      [item.brand, item.model].filter(Boolean).join(" ") || null,
    ].filter((part): part is string => !!part);
    return parts.join(" · ");
  }

  function onUnitChange(unitId: string) {
    const next = new URLSearchParams(params);
    if (unitId) next.set("unitId", unitId);
    else next.delete("unitId");
    // A room from the previous unit is never valid once the unit itself changes.
    next.delete("equipmentId");
    setParams(next, { replace: true });
  }

  function onRoomChange(equipmentId: string) {
    const next = new URLSearchParams(params);
    if (equipmentId) next.set("equipmentId", equipmentId);
    else next.delete("equipmentId");
    setParams(next, { replace: true });
  }

  const [queueCount, setQueueCount] = useState<number | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedEquipmentId) {
      setQueueCount(null);
      setQueueError(null);
      return;
    }
    let cancelled = false;
    setQueueError(null);
    api
      .get<QueueEntryDto[]>(`/queue?equipmentId=${selectedEquipmentId}&date=${today}`)
      .then((list) => {
        if (!cancelled) setQueueCount(list.length);
      })
      .catch((err) => {
        if (!cancelled) setQueueError(err instanceof Error ? err.message : t("workstation:roomStatusQueueError"));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEquipmentId, today, t]);

  useEffect(() => {
    if (!selectedEquipmentId) return;
    const sock = createSessionSocket();
    sock.connect();
    const onQueueUpdated = (payload: { equipmentId: string }) => {
      if (payload.equipmentId !== selectedEquipmentId) return;
      void api
        .get<QueueEntryDto[]>(`/queue?equipmentId=${selectedEquipmentId}&date=${today}`)
        .then((list) => setQueueCount(list.length))
        .catch(() => {
          // Best-effort refresh -- the count just stays at whatever it last was.
        });
    };
    sock.on(RT_EVENTS.QUEUE_UPDATED, onQueueUpdated);
    return () => {
      sock.disconnect();
    };
  }, [selectedEquipmentId, today]);

  function confirm() {
    if (!selectedUnitId || !selectedEquipmentId) return;
    navigate(`/exame?equipmentId=${selectedEquipmentId}`);
  }

  const displayStatus = selectedEquipment ? displayStatusOf(selectedEquipment) : null;

  return (
    <ConsoleShell activeNav="dashboard" pageTitle={t("workstation:heading")}>
      <h1 className="sr-only">{t("workstation:heading")}</h1>
      <p className="mb-4 text-muted-foreground">{t("workstation:intro")}</p>

      <Card className="mb-4 py-0">
        <CardHeader className="flex-row items-center gap-3 space-y-0 border-b [.border-b]:pb-4">
          <span className="rounded-md bg-accent px-2 py-0.5 text-xs font-bold tabular-nums text-accent-foreground">01</span>
          <CardTitle className="text-sm font-semibold tracking-wide uppercase">{t("workstation:accessProfileTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 py-5">
          {me && <IdentityCard role={me.role} email={me.email} professionalRegistration={me.professionalRegistration} />}
          {me && <RolePermissionSummary role={me.role} />}
        </CardContent>
      </Card>

      <Card className="mb-4 py-0">
        <CardHeader className="flex-row items-center gap-3 space-y-0 border-b [.border-b]:pb-4">
          <span className="rounded-md bg-accent px-2 py-0.5 text-xs font-bold tabular-nums text-accent-foreground">02</span>
          <CardTitle className="text-sm font-semibold tracking-wide uppercase">{t("workstation:clinicSectionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="py-5">
          {clinicsError && (
            <Alert variant="destructive" className="mb-3">
              <AlertDescription>
                {clinicsError}{" "}
                <button className="underline" onClick={() => void loadClinics()}>
                  {t("workstation:retry")}
                </button>
              </AlertDescription>
            </Alert>
          )}
          {switchError && (
            <Alert variant="destructive" className="mb-3">
              <AlertDescription>{switchError}</AlertDescription>
            </Alert>
          )}
          {!clinicsLoading && clinics.length === 0 && !clinicsError ? (
            <p className="text-sm text-muted-foreground">{t("workstation:noClinics")}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="workstation-clinic-select">{t("workstation:clinicLabel")}</Label>
              <Select
                value={selectedClinicId || undefined}
                disabled={clinicsLoading || switching}
                onValueChange={(value) => setClinicParam(value)}
              >
                <SelectTrigger id="workstation-clinic-select" className="w-full max-w-md">
                  <SelectValue placeholder={t("workstation:clinicPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {clinics.map((clinic) => (
                    <SelectItem key={clinic.id} value={clinic.id}>
                      {clinic.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {switching && (
                <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
                  {t("workstation:switchingClinic")}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4 py-0">
        <CardHeader className="flex-row items-center gap-3 space-y-0 border-b [.border-b]:pb-4">
          <span className="rounded-md bg-accent px-2 py-0.5 text-xs font-bold tabular-nums text-accent-foreground">03</span>
          <CardTitle className="text-sm font-semibold tracking-wide uppercase">{t("workstation:physicalConnectionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="py-5">
          {(unitsError || equipmentError) && (
            <Alert variant="destructive" className="mb-3">
              <AlertDescription>
                {unitsError ?? equipmentError}{" "}
                <button className="underline" onClick={() => void loadRooms()}>
                  {t("workstation:retry")}
                </button>
              </AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="workstation-unit-select">{t("workstation:unitLabel")}</Label>
              {!isActiveClinic ? (
                <Select disabled value={NONE}>
                  <SelectTrigger id="workstation-unit-select" className="w-full">
                    <SelectValue placeholder={t("workstation:unitPlaceholderNoClinic")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t("workstation:unitPlaceholderNoClinic")}</SelectItem>
                  </SelectContent>
                </Select>
              ) : !loading && units.length === 0 && !unitsError ? (
                <p className="text-sm text-muted-foreground">{t("workstation:noUnits")}</p>
              ) : (
                <Select value={selectedUnitId || undefined} disabled={loading} onValueChange={(value) => onUnitChange(value)}>
                  <SelectTrigger id="workstation-unit-select" className="w-full">
                    <SelectValue placeholder={t("workstation:unitPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {units.map((unit) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {unit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="workstation-room-select">{t("workstation:roomLabel")}</Label>
              {!selectedUnitId ? (
                <Select disabled value={NONE}>
                  <SelectTrigger id="workstation-room-select" className="w-full">
                    <SelectValue placeholder={t("workstation:roomPlaceholderNoUnit")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t("workstation:roomPlaceholderNoUnit")}</SelectItem>
                  </SelectContent>
                </Select>
              ) : roomsForUnit.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("workstation:noRoomsForUnit")}</p>
              ) : (
                <Select value={selectedEquipmentId || undefined} onValueChange={(value) => onRoomChange(value)}>
                  <SelectTrigger id="workstation-room-select" className="w-full">
                    <SelectValue placeholder={t("workstation:roomPlaceholderChoose")} />
                  </SelectTrigger>
                  <SelectContent>
                    {roomsForUnit.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {roomOptionLabel(item)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {selectedEquipment && displayStatus && (
            <Card className="mt-4 mb-0">
              <CardContent className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <strong>{selectedEquipment.roomLabel ?? selectedEquipment.name}</strong>
                  <div className="mt-1">
                    <Badge className={cn("border-transparent", tailwindBadgeClassOf(displayStatus))}>{t(statusLabelKeyOf(displayStatus))}</Badge>
                  </div>
                </div>
                <div className="flex flex-col gap-0.5" role="status" aria-live="polite">
                  {queueError ? (
                    <span className="text-sm text-destructive">{queueError}</span>
                  ) : queueCount === null ? null : queueCount === 0 ? (
                    <span className="text-sm text-muted-foreground">{t("workstation:roomStatusQueueCountZero")}</span>
                  ) : (
                    <span className="text-sm text-muted-foreground">{t("workstation:roomStatusQueueCount", { count: queueCount })}</span>
                  )}
                </div>
                {displayStatus !== "online" && <p className="m-0 text-[13px] text-muted-foreground">{t("workstation:offlineNotice")}</p>}
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        {/* `disabled:opacity-100`/solid muted colors, not the `Button` base's own
            `disabled:opacity-50` -- that relies on blending `bg-primary`/`text-primary-
            foreground` at 50% opacity over whatever sits behind the button, which axe
            measured at 2.24:1 once `<main>` claimed a real light background (an opacity
            blend that happened to still clear 4.5:1 against the *old*, unclaimed dark
            backdrop is not the same guarantee against the new one). This button is
            disabled by default, before any room is picked -- not just transiently
            mid-submit like every other page's own disabled button -- so it is exactly the
            one a real page load, and axe, actually sees in that state. */}
        <Button
          disabled={!selectedUnitId || !selectedEquipmentId}
          onClick={confirm}
          className="disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100"
        >
          {t("workstation:confirm")}
        </Button>
      </div>
    </ConsoleShell>
  );
}
