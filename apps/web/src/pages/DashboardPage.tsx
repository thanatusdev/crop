import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { RT_EVENTS, type EquipmentDto, type MyClinic, type QueueEntryDto, type SessionState, type UnitDto } from "@crop/shared";
import { Loader2, X } from "lucide-react";
import { cn } from "cn";
import { api, ApiError } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { createSessionSocket } from "../lib/socket-client.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { computeNavPermissions } from "../lib/nav-permissions.js";
import { tailwindBadgeClassOf, type DisplayStatus } from "../lib/equipment-display.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Badge } from "../components/ui/badge.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";

interface EquipmentWithQueue extends EquipmentDto {
  queue: QueueEntryDto[];
}

/**
 * Two modes in one page, chosen by whether `?equipmentId=` is present:
 *
 *  - **Unscoped** (no query string): every piece of equipment the tenant has, exactly as
 *    before `WorkstationPage` existed. Still the landing page for every role except
 *    OPERATOR and NURSING (see role-routes.ts).
 *  - **Scoped**: one room only -- reached from `WorkstationPage`'s "Confirmar e Acessar
 *    Sala" (the OPERATOR's real per-room exam surface until a dedicated one exists; see
 *    that page's own docstring for why this is the honest destination rather than a
 *    fabricated new screen). The per-equipment queue fetch below only runs for the rooms
 *    actually rendered, so scoping is a real fetch reduction too, not just a filtered view
 *    of the same requests.
 *
 * **The clinic selector below is a real fix, not a new feature grafted on.** `GET /equipment`
 * has never taken a target-tenant parameter -- it always operates on `user.tenantId` -- so a
 * multi-clinic `CLINIC_ADMIN` (the `gestor.multi@crop.health` seed account, home Alpha,
 * also linked to Beta) has never had any way to see Beta's equipment/sessions from this
 * page, even though `POST /auth/active-clinic` has existed on the backend the whole time;
 * `AdminUnitsPage`/`AdminUsersPage`'s own multi-clinic support only ever worked around this
 * by passing an explicit `clinicTenantId` *parameter* to endpoints that accept one, which
 * `GET /equipment` never has. That was a narrow, easy-to-not-notice gap while it only
 * affected a manager's secondary clinics.
 *
 * It stopped being narrow the moment `OPERATOR_ADMIN`/`OPERATIONAL_SUPERVISOR` became
 * OPERATOR_PROVIDER-only (see `packages/shared/src/roles.ts`): their home tenant now owns no
 * equipment at all, ever, so without a way to switch clinics from here, this page -- their
 * actual landing page -- showed "No equipment registered" permanently, with no path forward.
 * `useAuth().switchActiveClinic` (see its own docstring) is what closes that, for both cases
 * at once: the selector renders whenever there is more than one candidate clinic, or the
 * active tenant isn't a clinic on the list at all (a cross-tenant role that hasn't switched
 * yet) -- a single-clinic `CLINIC_ADMIN`, the overwhelming common case, still sees nothing
 * extra.
 *
 * Rebuilt on shadcn/ui in a later pass -- `Table` for the per-room patient queue,
 * `Select` for the clinic picker, `Badge` for equipment status (same hex pairs as the old
 * `.badge.online`/etc., not re-picked). The scoped mode's own context strip and clinic
 * picker keep their pt-BR strings (the `workstation` namespace, same seam
 * `docs/architecture.md` already documents for `ConsoleShell`'s own English/pt-BR mix);
 * everything else on this still-largely-English page stays English, unchanged.
 */
export default function DashboardPage() {
  const { user, switchActiveClinic } = useAuth();
  const { t } = useTranslation(["workstation"]);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const scopedEquipmentId = params.get("equipmentId") ?? "";
  const scopedUnitId = params.get("unitId") ?? "";
  const [equipment, setEquipment] = useState<EquipmentWithQueue[]>([]);
  const [units, setUnits] = useState<UnitDto[]>([]);
  const [activeSessions, setActiveSessions] = useState<SessionState[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newPatientName, setNewPatientName] = useState<Record<string, string>>({});
  const [queueActionId, setQueueActionId] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  // AuditPage isn't part of ConsoleShell's own nav (not shown in the mock this shell was
  // built from) -- rendered as a plain inline link here instead.
  const { canViewAudit } = computeNavPermissions(user?.role);

  const [myClinics, setMyClinics] = useState<MyClinic[]>([]);
  const [switchingClinic, setSwitchingClinic] = useState(false);
  const [clinicError, setClinicError] = useState<string | null>(null);

  // Independent of `load()` below on purpose: this list doesn't change when the scoped room
  // does, and fetching it unconditionally (rather than only in unscoped mode) means returning
  // from a scoped view straight back to "/" never has to wait on a second round trip.
  useEffect(() => {
    void api
      .get<MyClinic[]>("/auth/me/clinics")
      .then(setMyClinics)
      .catch(() => {
        // Best-effort, same reasoning as ConsoleShell's own health-pill fetch -- the selector
        // just doesn't render if this fails, rather than blocking the whole page.
      });
  }, []);

  async function switchClinic(clinicTenantId: string) {
    if (!clinicTenantId) return;
    setSwitchingClinic(true);
    setClinicError(null);
    try {
      await switchActiveClinic(clinicTenantId);
      await load();
    } catch (err) {
      setClinicError(err instanceof ApiError ? err.message : t("workstation:clinicSwitchError"));
    } finally {
      setSwitchingClinic(false);
    }
  }

  useEffect(() => {
    void load();
    // Re-run when the scoped room changes (a different `?equipmentId=` navigated to from
    // WorkstationPage) -- otherwise this would keep showing the previous room's queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedEquipmentId]);

  // Live push: another user adding/cancelling a queue entry, or the health poller flipping
  // an equipment's status, would otherwise only ever show up here after a manual reload --
  // RT_EVENTS.QUEUE_UPDATED/EQUIPMENT_STATUS_CHANGED exist specifically so this doesn't have
  // to be true. Reusing createSessionSocket (not actually session-specific, just an
  // authenticated /rt connection) rather than introducing a second connection helper --
  // SessionsGateway.handleConnection auto-joins every socket to its own tenant's room, so no
  // extra subscribe step is needed here beyond just connecting.
  //
  // Reconnected on every clinic switch (keyed on `user?.tenantId`), not just on mount: a
  // socket connected before a switch keeps listening to whichever tenant room it joined at
  // handshake time forever (see `WorkstationPage`'s identical fix, and its own longer
  // comment on why `createSessionSocket()` can't just pick up a later token change).
  useEffect(() => {
    const sock = createSessionSocket();
    sock.connect();
    sock.on(RT_EVENTS.QUEUE_UPDATED, () => void load());
    sock.on(RT_EVENTS.EQUIPMENT_STATUS_CHANGED, () => void load());
    return () => {
      sock.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenantId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [equipmentList, sessions] = await Promise.all([
        api.get<EquipmentDto[]>("/equipment"),
        api.get<SessionState[]>("/sessions/active"),
      ]);
      // Scoped mode: only the one room WorkstationPage sent the operator to needs its
      // queue fetched -- everything else on the tenant is deliberately not requested.
      const targetList = scopedEquipmentId ? equipmentList.filter((e) => e.id === scopedEquipmentId) : equipmentList;
      const withQueue = await Promise.all(
        targetList.map(async (e) => ({ ...e, queue: await api.get<QueueEntryDto[]>(`/queue?equipmentId=${e.id}`) }))
      );
      setEquipment(withQueue);
      setActiveSessions(sessions);
      // The unit name in the context strip is the only reason this page ever needs
      // `/units` -- not fetched at all in unscoped mode.
      if (scopedEquipmentId) setUnits(await api.get<UnitDto[]>("/units"));
    } catch (err) {
      // Distinct from "no equipment registered" below -- an empty array here on a failed
      // fetch would otherwise be indistinguishable from a tenant that genuinely has none.
      setError(err instanceof Error ? err.message : "Could not load equipment. Check your connection and retry.");
    } finally {
      setLoading(false);
    }
  }

  function activeSessionFor(equipmentId: string): SessionState | undefined {
    return activeSessions.find((s) => s.equipmentId === equipmentId);
  }

  async function startSession(equipmentId: string, queueEntryId?: string) {
    setError(null);
    setStartingId(equipmentId);
    try {
      const session = await api.post<SessionState>("/sessions", { equipmentId, queueEntryId });
      navigate(`/sessions/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start session");
    } finally {
      setStartingId(null);
    }
  }

  async function addPatient(equipmentId: string, ev: React.FormEvent) {
    ev.preventDefault();
    const patientFirstName = (newPatientName[equipmentId] ?? "").trim();
    if (!patientFirstName) return;
    setQueueError(null);
    setQueueActionId(equipmentId);
    try {
      await api.post("/queue", { equipmentId, patientFirstName });
      setNewPatientName((prev) => ({ ...prev, [equipmentId]: "" }));
      await load();
    } catch (err) {
      setQueueError(err instanceof ApiError ? err.message : "Could not add this patient to the queue.");
    } finally {
      setQueueActionId(null);
    }
  }

  async function cancelQueueEntry(queueEntryId: string) {
    setQueueError(null);
    setQueueActionId(queueEntryId);
    try {
      await api.post(`/queue/${queueEntryId}/status`, { status: "CANCELLED" });
      await load();
    } catch (err) {
      setQueueError(err instanceof ApiError ? err.message : "Could not cancel this queue entry.");
    } finally {
      setQueueActionId(null);
    }
  }

  const scopedRoom = scopedEquipmentId ? equipment.find((e) => e.id === scopedEquipmentId) ?? null : null;
  const scopedUnit = scopedRoom?.unitId ? units.find((u) => u.id === scopedRoom.unitId) ?? null : null;
  // Reached via a stale link (e.g. the room was retired since it was bookmarked) rather
  // than one the equipment list actually contains -- distinct from "tenant has no
  // equipment at all" below, which is a different, unscoped state.
  const scopedRoomNotFound = !loading && !error && scopedEquipmentId !== "" && equipment.length === 0;

  // Derived from `user.tenantId` rather than each clinic's own static `active` flag, so this
  // stays correct the instant `switchClinic` resolves without waiting on a second
  // `/auth/me/clinics` round trip: the flag on that response only reflected whichever tenant
  // was active *at fetch time*, and `switchActiveClinic` changes that without refetching it.
  const isOnAContractedClinic = myClinics.some((c) => c.id === user?.tenantId);
  // Show the picker when there is a real choice (more than one clinic) or none has been
  // entered yet at all -- never for the common single-clinic case, where it would be a
  // one-option dropdown doing nothing. See this file's own docstring for why this exists.
  const needsClinicPicker = !scopedEquipmentId && (myClinics.length > 1 || !isOnAContractedClinic);
  // Only meaningful while there is a real choice pending -- a role with zero contracted
  // clinics at all gets the plain "no equipment" message below instead, since there is
  // nothing this copy could usefully tell them to do about it from here.
  const clinicNotYetSelected = !scopedEquipmentId && myClinics.length > 0 && !isOnAContractedClinic;

  return (
    <ConsoleShell activeNav="dashboard" pageTitle="Equipment">
      {/* `ConsoleShell`'s own topbar renders `pageTitle` as a plain `<strong>`, not a
          heading -- every other page built on this shell (NursingPage, WorkstationPage,
          AdminUsersPage...) supplies its own level-one heading; this one never did, which
          is a real WCAG 2.4.6/axe `page-has-heading-one` failure the a11y test tier's own
          fresh run against a reset demo stack is what actually caught it. Visually hidden,
          same convention as every one of those. */}
      <h1 className="sr-only">Equipment</h1>
      {needsClinicPicker && (
        <Card className="mb-4">
          <CardContent>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dashboard-clinic-select">{t("workstation:clinicLabel")}</Label>
              <Select
                value={isOnAContractedClinic ? user!.tenantId : ""}
                disabled={switchingClinic}
                onValueChange={(value) => void switchClinic(value)}
              >
                <SelectTrigger id="dashboard-clinic-select" className="w-64">
                  <SelectValue placeholder={t("workstation:clinicPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {myClinics.map((clinic) => (
                    <SelectItem key={clinic.id} value={clinic.id}>
                      {clinic.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {clinicError && (
              <Alert variant="destructive" className="mt-3">
                <AlertDescription>{clinicError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
      {scopedEquipmentId && (
        <Card className="mb-4 flex-row items-center justify-between gap-3 py-4">
          <CardContent className="flex-1">
            <strong>{scopedRoom?.roomLabel ?? scopedRoom?.name ?? scopedEquipmentId}</strong>
            {scopedUnit && <span className="text-sm text-muted-foreground"> · {scopedUnit.name}</span>}
          </CardContent>
          <Link
            className="mr-6 text-sm text-primary hover:underline"
            to={`/posto-de-trabalho?unitId=${scopedUnitId}&equipmentId=${scopedEquipmentId}`}
          >
            {t("workstation:switchWorkstation")}
          </Link>
        </Card>
      )}
      {scopedRoomNotFound && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            {t("workstation:scopedRoomNotFound")}{" "}
            <Link className="text-primary hover:underline" to="/posto-de-trabalho">
              {t("workstation:switchWorkstation")}
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {canViewAudit && (
        <p className="-mt-2 mb-4">
          <button className="cursor-pointer text-primary underline" onClick={() => navigate("/audit")}>
            Audit log
          </button>
        </p>
      )}
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            {error}{" "}
            <button className="underline" onClick={() => void load()}>
              Retry
            </button>
          </AlertDescription>
        </Alert>
      )}
      {loading ? (
        <p aria-live="polite">Loading...</p>
      ) : equipment.length === 0 ? (
        error || scopedRoomNotFound ? null : clinicNotYetSelected ? (
          <p className="text-muted-foreground">{t("workstation:dashboardNoClinicSelected")}</p>
        ) : (
          <p className="text-muted-foreground">No equipment registered for your tenant yet.</p>
        )
      ) : (
        <div className="flex flex-col gap-4">
          {equipment.map((item) => {
            const activeSession = activeSessionFor(item.id);
            const nextPatient = item.queue.find((q) => q.status === "WAITING");
            return (
              <Card key={item.id}>
                <CardContent>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="inline text-base font-semibold">{item.name}</h2>{" "}
                      <Badge className={cn("border-transparent", tailwindBadgeClassOf(item.status.toLowerCase() as DisplayStatus))}>
                        {item.status}
                      </Badge>
                      <div className="text-sm text-muted-foreground">
                        {item.targetOs} · keymap {item.keymap} · {item.screenWidth}x{item.screenHeight}
                      </div>
                    </div>
                    {activeSession ? (
                      <Button onClick={() => navigate(`/sessions/${activeSession.id}`)}>Rejoin session</Button>
                    ) : (
                      <Button
                        disabled={item.status !== "ONLINE" || startingId === item.id}
                        title={item.status !== "ONLINE" ? `Equipment is ${item.status.toLowerCase()}, not reachable` : undefined}
                        onClick={() => startSession(item.id, nextPatient?.id)}
                      >
                        {startingId === item.id && <Loader2 className="animate-spin" />}
                        {startingId === item.id ? "Starting..." : "Start session"}
                      </Button>
                    )}
                  </div>

                  <h3 className="mt-3 mb-1.5 text-sm font-semibold">Patient queue</h3>
                  {queueError && (
                    <Alert variant="destructive" className="mb-2">
                      <AlertDescription>{queueError}</AlertDescription>
                    </Alert>
                  )}
                  {item.queue.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Empty.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>#</TableHead>
                          <TableHead>Patient</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {item.queue.map((q) => (
                          <TableRow key={q.id}>
                            <TableCell>{q.position}</TableCell>
                            <TableCell>{q.patientFirstName}</TableCell>
                            <TableCell>{q.status}</TableCell>
                            <TableCell>
                              {q.status === "WAITING" && (
                                <button
                                  className="text-primary underline disabled:pointer-events-none disabled:opacity-50"
                                  disabled={queueActionId === q.id}
                                  onClick={() => cancelQueueEntry(q.id)}
                                >
                                  Cancel
                                </button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                  <form onSubmit={(ev) => addPatient(item.id, ev)} className="mt-2.5 flex gap-2">
                    <Label className="sr-only" htmlFor={`add-patient-${item.id}`}>
                      Add a patient to {item.name}'s queue
                    </Label>
                    <Input
                      id={`add-patient-${item.id}`}
                      placeholder="Patient name"
                      value={newPatientName[item.id] ?? ""}
                      onChange={(e) => setNewPatientName((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    />
                    <Button variant="secondary" type="submit" disabled={queueActionId === item.id}>
                      Add to queue
                    </Button>
                  </form>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </ConsoleShell>
  );
}

