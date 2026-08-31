/**
 * The first "event" (as opposed to command/query) in this codebase's use of @nestjs/cqrs --
 * published by CreateQueueEntryHandler/UpdateQueueStatusHandler purely so SessionsModule's
 * BroadcastQueueUpdatedHandler can push RT_EVENTS.QUEUE_UPDATED to connected dashboards,
 * without QueueModule needing to import SessionsModule (which already imports QueueModule
 * for StartSessionHandler/EndSessionHandler -- a direct import back would be a real module
 * cycle). CQRS events are discovered globally regardless of which module declares the
 * handler, so this stays fully decoupled: QueueModule has no idea anything is listening.
 */
export class QueueUpdatedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly equipmentId: string
  ) {}
}
