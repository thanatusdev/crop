/**
 * Published by UpdatePreparationStatusHandler so SessionsModule's
 * BroadcastPatientPreparationUpdatedHandler can push RT_EVENTS.PATIENT_PREPARATION_UPDATED to
 * connected clients, without QueueModule importing SessionsModule -- same anti-cycle
 * reasoning as QueueUpdatedEvent (see that file's own docstring). `sessionId` is nullable:
 * a patient can be positioned before any session exists against their queue entry.
 */
export class PatientPreparationUpdatedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly equipmentId: string,
    public readonly queueEntryId: string,
    public readonly sessionId: string | null
  ) {}
}
