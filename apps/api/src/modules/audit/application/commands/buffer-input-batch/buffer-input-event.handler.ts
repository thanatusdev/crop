import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AUDIT_BUFFER, type AuditBufferPort } from "../../ports/audit-buffer.port.js";
import { BufferInputEventCommand } from "./buffer-input-event.command.js";

/**
 * The high-frequency, buffered side of the two-tier audit design. Callers on the hot input
 * path (ProcessHidInputHandler) dispatch this without awaiting it -- see that handler for
 * why blocking the input path on Redis would cost part of the latency budget for no benefit.
 */
@CommandHandler(BufferInputEventCommand)
export class BufferInputEventHandler implements ICommandHandler<BufferInputEventCommand, void> {
  constructor(@Inject(AUDIT_BUFFER) private readonly buffer: AuditBufferPort) {}

  async execute(command: BufferInputEventCommand): Promise<void> {
    await this.buffer.push(command.sessionId, command.item);
  }
}
