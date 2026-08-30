import { Inject, Logger } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { remapModifierCode } from "@crop/shared";
import { ForbiddenError } from "../../../../../shared/domain/errors.js";
import { MetricsService } from "../../../../../shared/infrastructure/metrics/metrics.service.js";
import { BufferInputEventCommand } from "../../../../audit/application/commands/buffer-input-batch/buffer-input-event.command.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../../ports/pikvm-gateway.port.js";
import { SESSION_RUNTIME, type SessionRuntimePort } from "../../ports/session-runtime.port.js";
import { ProcessHidInputCommand } from "./process-hid-input.command.js";

/**
 * The 60-events-per-second hot path. Everything here is either an in-memory check, a
 * fire-and-forget WebSocket send, or a fire-and-forget Redis push -- nothing in this method
 * awaits a network round trip before returning, which is what keeps this handler's own
 * overhead a negligible fraction of the sub-200ms budget.
 */
@CommandHandler(ProcessHidInputCommand)
export class ProcessHidInputHandler implements ICommandHandler<ProcessHidInputCommand, void> {
  private readonly logger = new Logger(ProcessHidInputHandler.name);

  constructor(
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    @Inject(SESSION_RUNTIME) private readonly runtime: SessionRuntimePort,
    private readonly commandBus: CommandBus,
    private readonly metrics: MetricsService
  ) {}

  async execute(command: ProcessHidInputCommand): Promise<void> {
    // Defense in depth: the gateway already checks this before dispatching, but this handler
    // must never trust a caller that skipped that check (e.g. a future internal API).
    const controller = this.runtime.getController(command.sessionId);
    if (controller !== command.userId) {
      throw new ForbiddenError("Only the current controller may send input for this session");
    }

    const startedAt = performance.now();
    this.forward(command);
    this.metrics.hidForwardDurationSeconds.observe((performance.now() - startedAt) / 1000);
    this.metrics.hidInputEventsTotal.inc({ event_type: command.event.type });

    this.runtime.recordActivity(command.sessionId); // resets the idle-timeout clock -- see SessionIdleScheduler

    // Never awaited: buffering is Redis-backed audit history, not a safety-critical write,
    // and blocking the input path on it would spend part of the latency budget for nothing.
    this.commandBus
      .execute(
        new BufferInputEventCommand(command.sessionId, {
          tenantId: command.tenantId,
          userId: command.userId,
          event: command.event,
        })
      )
      .catch((err: Error) => this.logger.warn(`Failed to buffer input event: ${err.message}`));
  }

  private forward(command: ProcessHidInputCommand): void {
    const { equipmentId, event } = command;
    switch (event.type) {
      case "key": {
        const code = remapModifierCode(event.code, command.clientOs, command.targetOs);
        this.pikvm.sendKey(equipmentId, code, event.state, false);
        break;
      }
      case "mouse_move":
        this.pikvm.sendMouseMove(equipmentId, event.x, event.y);
        break;
      case "mouse_button":
        this.pikvm.sendMouseButton(equipmentId, event.button, event.state);
        break;
      case "mouse_wheel":
        this.pikvm.sendMouseWheel(equipmentId, event.deltaX, event.deltaY);
        break;
    }
  }
}
