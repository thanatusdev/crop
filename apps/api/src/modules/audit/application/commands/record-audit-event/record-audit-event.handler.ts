import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AUDIT_REPOSITORY, type AuditRepositoryPort } from "../../ports/audit-repository.port.js";
import { RecordAuditEventCommand } from "./record-audit-event.command.js";

/**
 * The synchronous, "never buffered" side of the two-tier audit design: login, MFA,
 * session start/end, takeover, and blocked ATX/MSD attempts all go through this handler and
 * are durable before the caller's request completes. Contrast with BufferInputEventHandler.
 */
@CommandHandler(RecordAuditEventCommand)
export class RecordAuditEventHandler implements ICommandHandler<RecordAuditEventCommand, void> {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepositoryPort) {}

  async execute(command: RecordAuditEventCommand): Promise<void> {
    await this.repository.appendCritical(command.event);
  }
}
