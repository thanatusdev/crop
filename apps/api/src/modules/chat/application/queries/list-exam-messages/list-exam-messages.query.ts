import type { AccessTokenClaims } from "@crop/shared";

export class ListExamMessagesQuery {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string,
    /** See GetEquipmentQuery.actor. */
    public readonly actor?: AccessTokenClaims,
    /** `YYYY-MM-DD`, a clinic-local calendar day -- see `clinic-day.ts`. Optional: omitting
     * it keeps the pre-day-scoping behaviour ("this room's whole history"), which
     * `SendExamMessageHandler`'s own current-patient lookup still relies on internally
     * (it has no day to scope by). `ChatController`'s own REST route defaults this to
     * *today* before the query is ever built -- unlike `ListQueueByEquipmentQuery.day`, which
     * stays genuinely unscoped for its own pre-existing callers, this route is new enough
     * (and single-purpose enough) that "today" is the only sensible default rather than
     * "everything". */
    public readonly day?: string
  ) {}
}
