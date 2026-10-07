import { AgreementStatus, EquipmentStatus, type EquipmentDto, type OperatorAgreementDto, type QueueEntryDto, type UserDto } from "@crop/shared";

/**
 * The "Painel" (`DashboardPage`) summary-card row's numbers -- one per card, computed from
 * arrays the page already has in memory or fetches for exactly this purpose, never from a
 * dedicated `/dashboard/stats` endpoint. Same reasoning as `equipment-display.ts`'s own
 * `summarize()`: every one of these lists is small (a tenant's own equipment/users/agreements,
 * or one clinic-day's queue), so a second round trip could only let the cards and the rest of
 * the page disagree with each other.
 *
 * Every field here is optional on input (see `summarizeDashboard`'s parameters) because which
 * cards a role even gets to see varies -- `canManageUsers`/`canManageAgreements` gate whether
 * `DashboardPage` ever fetches `users`/`agreements` at all, and `LOCAL_IT` never fetches queue
 * data (`GET /queue` 403s for that role; see `DashboardPage.load`'s own comment on its
 * per-room queue fetch). A card whose underlying list was never fetched renders nothing, not
 * a misleading zero.
 */
export interface DashboardStats {
  equipmentTotal: number;
  equipmentOnline: number;
  /** `undefined` when the viewer's role can't call `GET /queue` at all (`LOCAL_IT`) -- distinct
   * from `0`, which is a real "no patients today" answer for every other role. */
  patientsToday: number | undefined;
  /** `undefined` when `GET /users` was never fetched (role lacks `canManageUsers`). */
  usersTotal: number | undefined;
  /** `undefined` when `GET /agreements` was never fetched (role lacks `canManageAgreements`). */
  agreementsActive: number | undefined;
  agreementsPending: number | undefined;
}

/**
 * `todayQueueByEquipmentId` is keyed by equipment id, one entry per room `DashboardPage`
 * successfully fetched `GET /queue?equipmentId=<id>&date=<today>` for -- a room that 403'd
 * (only possible for `LOCAL_IT`, see above) or hasn't resolved yet is simply absent, not an
 * empty array, so `patientsToday` can tell "zero rooms queried" apart from "queried, nobody
 * waiting." Summed, not matched one-to-one against `equipment`: a room retired mid-session or
 * not yet loaded shouldn't make this throw.
 */
export function summarizeDashboard(input: {
  equipment: readonly EquipmentDto[];
  todayQueueByEquipmentId?: ReadonlyMap<string, readonly QueueEntryDto[]>;
  users?: readonly UserDto[];
  agreements?: readonly OperatorAgreementDto[];
}): DashboardStats {
  const { equipment, todayQueueByEquipmentId, users, agreements } = input;

  let patientsToday: number | undefined;
  if (todayQueueByEquipmentId) {
    patientsToday = 0;
    for (const queue of todayQueueByEquipmentId.values()) patientsToday += queue.length;
  }

  let agreementsActive: number | undefined;
  let agreementsPending: number | undefined;
  if (agreements) {
    agreementsActive = agreements.filter((a) => a.status === AgreementStatus.ACTIVE).length;
    agreementsPending = agreements.filter((a) => a.status === AgreementStatus.PENDING).length;
  }

  return {
    equipmentTotal: equipment.length,
    equipmentOnline: equipment.filter((e) => e.status === EquipmentStatus.ONLINE).length,
    patientsToday,
    usersTotal: users?.length,
    agreementsActive,
    agreementsPending,
  };
}
