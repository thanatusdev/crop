import type { AccessTokenClaims } from "@crop/shared";

/** `GET /queue/:id/documents/:docId/content` -- see `GetQueueDocumentHandler`'s own
 * docstring for why this, unlike upload/remove, checks operator-agreement scope and has no
 * status gate. `actor` is optional for the same reason `GetQueueEntryQuery.actor` is: only a
 * real HTTP caller ever has one to check against. */
export class GetQueueDocumentQuery {
  constructor(
    public readonly queueEntryId: string,
    public readonly documentId: string,
    public readonly tenantId: string,
    public readonly actor?: AccessTokenClaims
  ) {}
}
