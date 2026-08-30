import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, UserRole } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { Session } from "../../../domain/session.entity.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../../ports/pikvm-gateway.port.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../../ports/session-repository.port.js";
import { SESSION_RUNTIME, type SessionRuntimePort } from "../../ports/session-runtime.port.js";
import { ExecuteTakeoverCommand } from "./execute-takeover.command.js";

const TAKEOVER_ALLOWED_ROLES: readonly UserRole[] = [
  UserRole.SUPERVISOR,
  UserRole.CLINIC_ADMIN,
  UserRole.PLATFORM_ADMIN,
];

/**
 * The command this whole feature is named after. Note the order of operations: input is
 * released on the device BEFORE control is reassigned, not after -- a key the outgoing
 * controller was holding must never silently carry over to the incoming one.
 */
@CommandHandler(ExecuteTakeoverCommand)
export class ExecuteTakeoverHandler implements ICommandHandler<ExecuteTakeoverCommand, Session> {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    @Inject(SESSION_RUNTIME) private readonly runtime: SessionRuntimePort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: ExecuteTakeoverCommand): Promise<Session> {
    if (!TAKEOVER_ALLOWED_ROLES.includes(command.supervisorRole)) {
      throw new ForbiddenError("Only a supervisor or admin may take over a session");
    }

    const session = await this.sessions.findById(command.sessionId);
    if (!session) throw new NotFoundError("Session", command.sessionId);

    session.assertCanBeTakenOverBy(command.supervisorId);

    await this.pikvm.releaseAllInput(session.equipmentId);

    await this.sessions.setController(session.id, command.supervisorId, command.supervisorId);
    this.runtime.setController(session.id, command.supervisorId);
    this.runtime.recordActivity(session.id); // don't let a takeover that lands near the idle threshold get swept immediately

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.supervisorId,
        sessionId: session.id,
        action: AuditAction.TAKEOVER_GRANTED,
        resourceType: "Session",
        resourceId: session.id,
        details: { previousControllerId: session.controllerUserId },
      })
    );

    const updated = await this.sessions.findById(session.id);
    if (!updated) throw new NotFoundError("Session", session.id); // unreachable in practice
    return updated;
  }
}
