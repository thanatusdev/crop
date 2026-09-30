/** The nurse's "Confirmar Nova Sequência" commit -- a full explicit ordering of one room's
 * WAITING patients (see ReorderQueueRequestSchema in packages/shared for why this is a full
 * ordering rather than a single move-to-index). */
export class ReorderQueueCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly equipmentId: string,
    public readonly orderedIds: readonly string[]
  ) {}
}
