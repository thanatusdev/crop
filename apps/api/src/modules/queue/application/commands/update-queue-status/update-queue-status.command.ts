import type { QueueStatus } from "@crop/shared";

export class UpdateQueueStatusCommand {
  constructor(
    public readonly queueEntryId: string,
    public readonly status: QueueStatus
  ) {}
}
