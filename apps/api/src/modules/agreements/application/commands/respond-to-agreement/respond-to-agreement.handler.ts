import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AgreementStatus, AuditAction } from "@crop/shared";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../../../access/application/ports/agreement-repository.port.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { OperatorAgreement } from "../../../../access/domain/operator-agreement.entity.js";
import { RespondToAgreementCommand } from "./respond-to-agreement.command.js";

/**
 * Accepts or rejects a pending proposal. The "only the side that did *not* propose may answer" rule
 * lives on the entity (`assertCanBeRespondedToBy`), not here, so a future bulk-response script
 * cannot reach a different conclusion by forgetting the check.
 *
 * Accepting is the moment access begins, which is why this is the one transition that must be
 * impossible to perform unilaterally -- and why it is audited against the clinic even when the
 * clinic is the one accepting: the reviewer's question is about the clinic's exposure either way.
 */
@CommandHandler(RespondToAgreementCommand)
export class RespondToAgreementHandler implements ICommandHandler<RespondToAgreementCommand, OperatorAgreement> {
  constructor(
    @Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: RespondToAgreementCommand): Promise<OperatorAgreement> {
    const existing = await this.agreements.findById(command.agreementId);
    if (!existing) throw new NotFoundError("OperatorAgreement", command.agreementId);

    const responderTenantId = command.actor.homeTenantId ?? command.actor.tenantId;
    existing.assertCanBeRespondedToBy(responderTenantId);

    const nextStatus = command.accept ? AgreementStatus.ACTIVE : AgreementStatus.REJECTED;
    const agreement = await this.agreements.recordResponse(existing.id, nextStatus, command.actor.sub);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: existing.clinicTenantId,
        userId: command.actor.sub,
        sessionId: null,
        action: command.accept ? AuditAction.AGREEMENT_ACCEPTED : AuditAction.AGREEMENT_REJECTED,
        resourceType: "OperatorAgreement",
        resourceId: agreement.id,
        details: {
          clinicTenantId: existing.clinicTenantId,
          operatorTenantId: existing.operatorTenantId,
          respondedByTenantId: responderTenantId,
          // How much the acceptance actually granted. An agreement accepted with no scope grants
          // nothing (see the model's comment), and a reviewer asking "what did we agree to" should
          // not have to reconstruct that from a later scope-change event.
          scopeCount: agreement.scopes.length,
        },
      })
    );

    return agreement;
  }
}
