import { Inject, Logger } from "@nestjs/common";
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
  private readonly logger = new Logger(PrintTextHandler.name);

  constructor(
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    @Inject(SESSION_RUNTIME) private readonly runtime: SessionRuntimePort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: PrintTextCommand): Promise<void> {
    if (this.runtime.getController(command.sessionId) !== command.userId) {
      throw new ForbiddenError("Only the current controller may type text for this session");
    }

    // `pikvm.printText` is a REST call (unlike sendKey/sendMouseMove, which are fire-and-
    // forget sends over an already-open HID WebSocket -- see ProcessHidInputHandler), so an
    // unreachable/slow device makes it *reject*, not just delay. Left unguarded, that
    // rejection used to propagate straight out of this handler and skip the audit dispatch
    // below entirely -- an attempted print action against a struggling device left no trace
    // at all, not even a failure record. Caught here so the attempt is always audited,
    // `delivered` reflecting whether PiKVM actually got it.
    let delivered = true;
    try {
      await this.pikvm.printText(command.equipmentId, command.text, command.keymap);
    } catch (err) {
      delivered = false;
      this.logger.warn(`printText failed for equipment ${command.equipmentId}: ${(err as Error).message}`);
    }

    this.runtime.recordActivity(command.sessionId);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.userId,
        sessionId: command.sessionId,
        action: AuditAction.PRINT_TEXT,
        resourceType: "Equipment",
        resourceId: command.equipmentId,
        details: { length: command.text.length, keymap: command.keymap, delivered },
      })
    );
  }
}
