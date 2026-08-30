import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../../ports/pikvm-gateway.port.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../../ports/session-repository.port.js";
import { ReleaseAllInputCommand } from "./release-all-input.command.js";

/**
 * The emergency escape hatch: releases every physically-held key/button on the target
 * console WITHOUT ending the session -- for the moment an operator suspects (but isn't
 * certain) that something is stuck, and wants the safety net without losing their place in
 * the workflow. Contrast with EndSessionHandler, which also releases input but as a side
 * effect of tearing the whole session down.
 */
@CommandHandler(ReleaseAllInputCommand)
export class ReleaseAllInputHandler implements ICommandHandler<ReleaseAllInputCommand, void> {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: ReleaseAllInputCommand): Promise<void> {
    const session = await this.sessions.findById(command.sessionId);
    if (!session) throw new NotFoundError("Session", command.sessionId);
    if (!session.isParticipant(command.requestedByUserId)) {
      throw new ForbiddenError("Only the operator or supervisor of this session may trigger an emergency release");
    }

    await this.pikvm.releaseAllInput(session.equipmentId);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.requestedByUserId,
        sessionId: session.id,
        action: AuditAction.HID_RESET,
        resourceType: "Equipment",
        resourceId: session.equipmentId,
        details: { trigger: "manual_emergency_release" },
      })
    );
  }
}
