import type { AccessTokenClaims } from "@crop/shared";

/** `day` (`YYYY-MM-DD`, a clinic-local calendar day -- see clinic-day.ts) is optional and
 * deliberately not defaulted to "today" anywhere server-side: DashboardPage's own patient-
 * queue table and the session-start "find the next WAITING patient" flow both call
 * `GET /queue` with no `date` at all and need every entry regardless of day, exactly as
 * before this query gained day-scoping. Only NursingPage's day-view passes `date`
 * explicitly (computed client-side via `todayClinicDayString()`), so omitting it is what
 * preserves the pre-existing, unscoped behaviour rather than a "today" default silently
 * hiding entries those two existing callers still need. */
export class ListQueueByEquipmentQuery {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string,
    public readonly day?: string,
    /** The HTTP caller, when there is one -- see GetEquipmentQuery.actor. Present means the
     * agreement scope is checked too, which matters here more than almost anywhere else: this
     * route returns patient first names. */
    public readonly actor?: AccessTokenClaims
  ) {}
}
