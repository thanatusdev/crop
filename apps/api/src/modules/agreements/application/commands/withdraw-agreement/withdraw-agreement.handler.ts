import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../../../access/application/ports/agreement-repository.port.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { OperatorAgreement } from "../../../../access/domain/operator-agreement.entity.js";
import { WithdrawAgreementCommand } from "./withdraw-agreement.command.js";

/**
 * The proposer takes back a proposal nobody has answered yet -- see
 * `OperatorAgreement.assertCanBeWithdrawnBy`. Lands on REVOKED ("Encerrado") rather than a status
 * of its own: nothing was ever in force, and REVOKED is already what `ProposeAgreementHandler`
 * reopens, so proposing again later reuses this same row. The audit action is what tells the two
 * apart.
 *
 * No `AgreementAccessReducedEvent`: a PENDING agreement never granted access, so there is no live
 * session it could have been covering.
 */
@CommandHandler(WithdrawAgreementCommand)
export class WithdrawAgreementHandler implements ICommandHandler<WithdrawAgreementCommand, OperatorAgreement> {
  constructor(
    @Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: WithdrawAgreementCommand): Promise<OperatorAgreement> {
    const existing = await this.agreements.findById(command.agreementId);
    if (!existing) throw new NotFoundError("OperatorAgreement", command.agreementId);

    const withdrawerTenantId = command.actor.homeTenantId ?? command.actor.tenantId;
    existing.assertCanBeWithdrawnBy(withdrawerTenantId);

    const agreement = await this.agreements.withdraw(existing.id, command.actor.sub);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        // Against the clinic, like every AGREEMENT_* action -- see ProposeAgreementHandler.
        tenantId: existing.clinicTenantId,
        userId: command.actor.sub,
        sessionId: null,
        action: AuditAction.AGREEMENT_WITHDRAWN,
        resourceType: "OperatorAgreement",
        resourceId: agreement.id,
        details: {
          clinicTenantId: existing.clinicTenantId,
          operatorTenantId: existing.operatorTenantId,
          withdrawnByTenantId: withdrawerTenantId,
        },
      })
    );

    return agreement;
  }
}
