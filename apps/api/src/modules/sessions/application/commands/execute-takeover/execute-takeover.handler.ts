import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, UserRole } from "@crop/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { Session } from "../../../domain/session.entity.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../../ports/pikvm-gateway.port.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../../ports/session-repository.port.js";
import { SESSION_RUNTIME, type SessionRuntimePort } from "../../ports/session-runtime.port.js";
import { ExecuteTakeoverCommand } from "./execute-takeover.command.js";

// OPERATOR_ADMIN added alongside the clinic/operator-provider role split (see
// packages/shared/src/roles.ts) -- same reasoning as SessionsGateway's VIEW_ALLOWED_ROLES.
const TAKEOVER_ALLOWED_ROLES: readonly UserRole[] = [
  UserRole.OPERATIONAL_SUPERVISOR,
  UserRole.CLINIC_ADMIN,
  UserRole.PLATFORM_ADMIN,
  UserRole.OPERATOR_ADMIN,
];

/**
 * The command this whole feature is named after. Note the order of operations: input is
 * released on the device BEFORE control is reassigned, not after -- a key the outgoing
 * controller was holding must never silently carry over to the incoming one.
 *
 * Every invocation is audited via `TAKEOVER_REQUESTED`, unconditionally, before any check
 * runs -- including ones that go on to fail. `TAKEOVER_GRANTED` is only added on success, so
 * "attempts with no matching grant" is a real, queryable signal of denied/failed/lost-the-race
 * takeover attempts, not just successful ones. Always attributed to the session's *actual*
 * tenant (`session.tenantId`), never the caller's own claimed tenant -- otherwise a
 * cross-tenant attempt would be misattributed to the attacker's own tenant, invisible to the
 * victim tenant's auditors, which would defeat the entire point of auditing it.
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
    const session = await this.sessions.findById(command.sessionId);
    if (!session) throw new NotFoundError("Session", command.sessionId);

    await this.audit(session.tenantId, command.supervisorId, session.id, AuditAction.TAKEOVER_REQUESTED, {
      previousControllerId: session.controllerUserId,
      requestingUserTenantId: command.tenantId,
    });

    // Multi-tenant isolation, enforced here rather than trusted to the gateway: unlike
    // HID_INPUT/PRINT_TEXT (which only ever act on a `data.session` populated by a prior,
    // tenant-checked JOIN_SESSION), the gateway dispatches this straight from a
    // client-supplied `sessionId` with no equivalent check of its own. Without this, any
    // authenticated SUPERVISOR/*_ADMIN -- in *any* tenant -- could take over any other
    // tenant's active session by sessionId alone: reassigning control of someone else's live
    // clinical equipment, and (worse) with no earlier bug in this project, doing so silently,
    // since PiKVM itself has no per-tenant concept to reject it at the device either.
    if (session.tenantId !== command.tenantId) {
      throw new ForbiddenError("Session does not belong to your tenant");
    }

    if (!TAKEOVER_ALLOWED_ROLES.includes(command.supervisorRole)) {
      throw new ForbiddenError("Only a supervisor or admin may take over a session");
    }

    session.assertCanBeTakenOverBy(command.supervisorId);

    await this.pikvm.releaseAllInput(session.equipmentId);

    // Compare-and-swap against the controller we just read: if it's changed since (another
    // takeover won a race that started after ours), this fails loudly instead of silently
    // overwriting a concurrent winner or leaving the in-memory SessionRuntimePort -- the
    // actual authority for live input gating -- pointing at someone the database no longer
    // agrees is in control.
    const applied = await this.sessions.setController(
      session.id,
      command.supervisorId,
      command.supervisorId,
      session.controllerUserId
    );
    if (!applied) {
      throw new ConflictError("This session was just taken over by someone else. Try again.");
    }

    this.runtime.setController(session.id, command.supervisorId);
    this.runtime.recordActivity(session.id); // don't let a takeover that lands near the idle threshold get swept immediately

    await this.audit(session.tenantId, command.supervisorId, session.id, AuditAction.TAKEOVER_GRANTED, {
      previousControllerId: session.controllerUserId,
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
