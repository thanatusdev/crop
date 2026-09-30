import type { AccessTokenClaims } from "@crop/shared";

export interface SendExamMessageAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

/**
 * `queueEntryId` is no longer a constructor argument -- it used to be read off the caller's
 * `data.session` (the socket's own join context), which no longer exists now that sending is
 * REST, not WebSocket-only (see `SendExamMessageRequestSchema`'s own docstring). The handler
 * now resolves the room's *current* patient itself, the same "IN_PROGRESS, else the next
 * WAITING" rule `currentPatientOf` already expresses client-side for `ExamPage`'s own
 * "start exam" prompt.
 *
 * `actor` carries the full claims (not just `authorUserId`, which doubles as the message's
 * own author) because the handler now has to re-derive the tenant + agreement-scope check
 * itself -- see `ListQueueByEquipmentQuery.actor`'s identical reasoning for why a command that
 * used to trust a prior gate (there, `GET /equipment/:id`; here, the socket's room
 * membership) needs the whole claims object once that gate is gone.
 */
export class SendExamMessageCommand {
  constructor(
    public readonly equipmentId: string,
    public readonly actor: AccessTokenClaims,
    public readonly body: string,
    public readonly attachment: SendExamMessageAttachment | null
  ) {}
}
