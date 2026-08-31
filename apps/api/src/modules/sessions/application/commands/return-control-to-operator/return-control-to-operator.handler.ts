import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, UserRole } from "@crop/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { Session } from "../../../domain/session.entity.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../../ports/pikvm-gateway.port.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../../ports/session-repository.port.js";
import { SESSION_RUNTIME, type SessionRuntimePort } from "../../ports/session-runtime.port.js";
import { ReturnControlToOperatorCommand } from "./return-control-to-operator.command.js";

// Deliberately the same set ExecuteTakeoverHandler uses: whoever is allowed to take control
// away from the operator is also who gets to decide when it's safe to hand it back. The
// operator can never reclaim their own session unilaterally just by asking -- if they could,
// a takeover would be trivially reversible by the very person it was needed against.
const RETURN_CONTROL_ALLOWED_ROLES: readonly UserRole[] = [
  UserRole.SUPERVISOR,
  UserRole.CLINIC_ADMIN,
  UserRole.PLATFORM_ADMIN,
];

/**
 * The mirror of ExecuteTakeoverHandler, structured identically on purpose (tenant check
 * before role check before domain check before device call before the CAS write) -- see
 * that handler's docstring for the reasoning behind each step, all of which applies here
 * unchanged. The one real difference: this always targets `session.operatorId`, never the
 * caller -- there is no general "transfer control to any given user" primitive, deliberately
 * (see docs/architecture.md on why this was scoped narrowly).
 */
@CommandHandler(ReturnControlToOperatorCommand)
export class ReturnControlToOperatorHandler implements ICommandHandler<ReturnControlToOperatorCommand, Session> {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    @Inject(SESSION_RUNTIME) private readonly runtime: SessionRuntimePort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: ReturnControlToOperatorCommand): Promise<Session> {
    const session = await this.sessions.findById(command.sessionId);
    if (!session) throw new NotFoundError("Session", command.sessionId);

    await this.audit(session.tenantId, command.actingUserId, session.id, AuditAction.RETURN_CONTROL_REQUESTED, {
      previousControllerId: session.controllerUserId,
    });

    // Same multi-tenant isolation fix as ExecuteTakeoverHandler, for the same reason: never
    // trust the gateway alone to have already checked this.
    if (session.tenantId !== command.tenantId) {
      throw new ForbiddenError("Session does not belong to your tenant");
    }

    if (!RETURN_CONTROL_ALLOWED_ROLES.includes(command.actingUserRole)) {
      throw new ForbiddenError("Only a supervisor or admin may return control to the operator");
    }

    session.assertControlCanBeReturnedToOperator();

    await this.pikvm.releaseAllInput(session.equipmentId);

    // Same compare-and-swap as takeover, guarding against the same class of race (e.g. two
    // different admins both deciding to hand control back at once, or a takeover landing in
    // the same window). `supervisorId` is passed through unchanged, not cleared: the session
    // keeps its record of who was involved as supervisor even after they're no longer the
    // one holding input, which is what keeps them a participant (see Session.isParticipant)
    // for replay/audit/re-takeover purposes afterward.
    const applied = await this.sessions.setController(
      session.id,
      session.operatorId,
      session.supervisorId,
      session.controllerUserId
    );
    if (!applied) {
      throw new ConflictError("This session's control just changed. Try again.");
    }

    this.runtime.setController(session.id, session.operatorId);
    this.runtime.recordActivity(session.id);

    await this.audit(session.tenantId, command.actingUserId, session.id, AuditAction.RETURN_CONTROL_GRANTED, {
      previousControllerId: session.controllerUserId,
      returnedToOperatorId: session.operatorId,
    });

    const updated = await this.sessions.findById(session.id);
    if (!updated) throw new NotFoundError("Session", session.id); // unreachable in practice
    return updated;
  }

  private async audit(
    tenantId: string,
    userId: string,
    sessionId: string,
    action: AuditAction,
    details: unknown
  ): Promise<void> {
    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId,
        userId,
        sessionId,
        action,
        resourceType: "Session",
        resourceId: sessionId,
        details,
      })
    );
  }
}
