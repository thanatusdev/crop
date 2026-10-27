import { Inject, Logger } from "@nestjs/common";
import { CommandBus, EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { AgreementAccessReducedEvent } from "../../../access/application/events/agreement-access-reduced.event.js";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../../access/application/ports/agreement-repository.port.js";
import { RecordAuditEventCommand } from "../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { SessionsGateway } from "../../presentation/sessions.gateway.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../ports/pikvm-gateway.port.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../ports/session-repository.port.js";
import { SESSION_RUNTIME, type SessionRuntimePort } from "../ports/session-runtime.port.js";

const SUSPENDED_MESSAGE: Record<AgreementAccessReducedEvent["reason"], string> = {
  agreement_revoked: "O contrato da empresa operadora com esta clínica foi encerrado. A empresa não tem mais o controle desta sessão; a equipe da clínica pode assumir o controle.",
  agreement_scope_reduced:
    "Este equipamento foi retirado do contrato da empresa operadora. A empresa não tem mais o controle desta sessão; a equipe da clínica pode assumir o controle.",
};

/**
 * When a company's agreement stops covering a device, its users stop controlling any live session
 * on it -- immediately, without ending the session.
 *
 * Ending it was the alternative and was rejected on purpose: a revoke is a commercial act, and
 * aborting an exam mid-acquisition because of one would leave a patient on the table with the
 * scanner mid-sequence. So the session stays up, held input is released (no key or button left
 * pressed), and `SessionRuntimePort.suspendControl` makes every input path refuse those users from
 * here on. The clinic's own supervisor or admin can take over, finish, or end it as usual; nobody
 * from the outside company can take control back (see `ExecuteTakeoverHandler` and
 * `ReturnControlToOperatorHandler`).
 *
 * Re-reads the committed agreement instead of trusting the event, so a scope save that removed
 * nothing (it is published on every save) suspends nothing.
 */
@EventsHandler(AgreementAccessReducedEvent)
export class SuspendOutsideControlHandler implements IEventHandler<AgreementAccessReducedEvent> {
  private readonly logger = new Logger(SuspendOutsideControlHandler.name);

  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(SESSION_RUNTIME) private readonly runtime: SessionRuntimePort,
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    @Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort,
    private readonly commandBus: CommandBus,
    private readonly gateway: SessionsGateway
  ) {}

  async handle(event: AgreementAccessReducedEvent): Promise<void> {
    try {
      await this.suspend(event);
    } catch (err) {
      // An event handler's failure never reaches the revoke request that triggered it; log it
      // loudly rather than let it vanish as an unhandled rejection.
      this.logger.error(`Could not suspend outside control after ${event.reason}: ${(err as Error).message}`);
    }
  }

  private async suspend(event: AgreementAccessReducedEvent): Promise<void> {
    const affected = await this.sessions.listActiveInClinicInvolvingTenant(event.clinicTenantId, event.operatorTenantId);
    if (affected.length === 0) return;

    const agreement = await this.agreements.findActiveForOperatorInClinic(event.operatorTenantId, event.clinicTenantId);
    const message = SUSPENDED_MESSAGE[event.reason];

    for (const { session, outsideUserIds } of affected) {
      if (outsideUserIds.length === 0) continue;
      const equipment = await this.agreements.findEquipmentForScopeCheck(session.equipmentId);
      if (agreement && equipment && agreement.grantsAccessTo(equipment)) continue;

      const controllerBefore = this.runtime.getController(session.id);
      this.runtime.suspendControl(session.id, { outsideTenantId: event.operatorTenantId, userIds: outsideUserIds, message });
      await this.commandBus.execute(
        new RecordAuditEventCommand({
          tenantId: session.tenantId,
          userId: null, // system-initiated, as a consequence of the agreement change already audited
          sessionId: session.id,
          action: AuditAction.SESSION_CONTROL_SUSPENDED,
          resourceType: "Session",
          resourceId: session.id,
          details: { reason: event.reason, operatorTenantId: event.operatorTenantId, suspendedUserIds: outsideUserIds },
        })
      );

      this.gateway.broadcastControlSuspended(session.id, outsideUserIds, message);

      // Only if they were actually driving it: releasing input under a clinic supervisor who had
      // already taken over would drop *their* held key. Not awaited: `suspendControl` above is
      // what stops their input, instantly; this only lets go of anything already held, and an
      // unresponsive device must not delay the audit, the notice, or the next session in the loop.
      if (controllerBefore !== undefined && outsideUserIds.includes(controllerBefore)) {
        void this.pikvm.releaseAllInput(session.equipmentId).catch((err: Error) => {
          this.logger.error(`releaseAllInput after control suspension failed: ${err.message}`);
        });
      }
    }
  }
}
