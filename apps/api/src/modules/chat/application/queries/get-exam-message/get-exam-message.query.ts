import type { AccessTokenClaims } from "@crop/shared";

/** Backs `GET /chat/messages/:id/attachment` -- a single-resource read, re-checking tenancy
 * and agreement scope through the message's own equipment, the same "never take a path from
 * the URL" discipline `SessionsController.getSnapshotImage` already follows for
 * `SessionSnapshot.imagePath`. */
export class GetExamMessageQuery {
  constructor(
    public readonly messageId: string,
    public readonly tenantId: string,
    public readonly actor: AccessTokenClaims
  ) {}
}
