import type { ExamMessageDto } from "@crop/shared";

/**
 * Published by `SendExamMessageHandler` once a message (and its optional attachment) is
 * durably persisted, so `SessionsModule`'s `BroadcastExamMessageHandler` can push
 * `RT_EVENTS.EXAM_MESSAGE_CREATED` to the equipment's own chat room, without `ChatModule`
 * needing to import `SessionsModule` (which already imports `ChatModule`'s sibling
 * `EquipmentModule`/`QueueModule` -- a direct import back would risk exactly the kind of
 * cycle `QueueUpdatedEvent`'s own docstring documents avoiding). Carries the fully-resolved
 * DTO (including `authorName`), not just an id, so the broadcast handler never needs its own
 * re-fetch-and-resolve-name round trip -- `SendExamMessageHandler` already did that work once
 * for the REST response, and every socket in the room should render the exact same shape that
 * response returned.
 */
export class ExamMessageSentEvent {
  constructor(
    public readonly tenantId: string,
    public readonly equipmentId: string,
    public readonly message: ExamMessageDto
  ) {}
}
