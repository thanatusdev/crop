import type { UpdatePreparationStatusRequest } from "@crop/shared";

/** `status` is deliberately the same narrowed union `UpdatePreparationStatusRequestSchema`
 * infers (POSITIONED | INJECTED | RELEASED, never NOT_STARTED) rather than the full
 * `PreparationStatus` enum -- so this command's type alone rules out the one value nothing
 * downstream should ever have to defensively re-check for. */
export class UpdatePreparationStatusCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly queueEntryId: string,
    public readonly status: UpdatePreparationStatusRequest["status"]
  ) {}
}

