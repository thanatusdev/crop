import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../../ports/pikvm-gateway.port.js";
import { SESSION_RUNTIME, type SessionRuntimePort } from "../../ports/session-runtime.port.js";
import { PrintTextCommand } from "./print-text.command.js";

/**
 * Text (patient names/IDs, especially accented ones) goes through `/api/hid/print` rather
 * than per-key events -- see docs/pikvm-integration.md. Logged with length + keymap only,
 * not the literal text: the audit trail should prove the action happened without duplicating
 * patient-identifying data into a second table.
 */
@CommandHandler(PrintTextCommand)
export class PrintTextHandler implements ICommandHandler<PrintTextCommand, void> {
  constructor(
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    @Inject(SESSION_RUNTIME) private readonly runtime: SessionRuntimePort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: PrintTextCommand): Promise<void> {
    if (this.runtime.getController(command.sessionId) !== command.userId) {
      throw new ForbiddenError("Only the current controller may type text for this session");
    }

    await this.pikvm.printText(command.equipmentId, command.text, command.keymap);
    this.runtime.recordActivity(command.sessionId);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.userId,
        sessionId: command.sessionId,
        action: AuditAction.PRINT_TEXT,
        resourceType: "Equipment",
        resourceId: command.equipmentId,
        details: { length: command.text.length, keymap: command.keymap },
      })
    );
  }
}
