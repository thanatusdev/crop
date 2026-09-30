import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../../../access/application/ports/agreement-repository.port.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { OperatorAgreement } from "../../../../access/domain/operator-agreement.entity.js";
import { RevokeAgreementCommand } from "./revoke-agreement.command.js";

/**
 * Ends a live contract. Unilateral by design, unlike acceptance -- see
 * `OperatorAgreement.assertCanBeRevokedBy` for why requiring the counterparty's consent to *stop*
 * would be the wrong default.
 *
 * Revocation takes effect immediately for data access, without invalidating any token: every path
 * that touches the clinic's data re-reads the agreement (`ClinicAccessChecker`,
 * `OperatorAccessService` on all equipment reads), so an operator holding a clinic-scoped token
 * issued a second ago can no longer reach anything through it. Sessions already running are not
 * force-ended here -- that is a separate, deliberate decision: killing a session mid-scan because a
 * contract was revoked would be a clinical-safety hazard, and the clinic's own "End session" control
 * already exists for the case where they want it stopped now.
 */
@CommandHandler(RevokeAgreementCommand)
export class RevokeAgreementHandler implements ICommandHandler<RevokeAgreementCommand, OperatorAgreement> {
  constructor(
    @Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: RevokeAgreementCommand): Promise<OperatorAgreement> {
    const existing = await this.agreements.findById(command.agreementId);
    if (!existing) throw new NotFoundError("OperatorAgreement", command.agreementId);

    const revokerTenantId = command.actor.homeTenantId ?? command.actor.tenantId;
    existing.assertCanBeRevokedBy(revokerTenantId);

    const agreement = await this.agreements.revoke(existing.id, command.actor.sub);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: existing.clinicTenantId,
        userId: command.actor.sub,
        sessionId: null,
        action: AuditAction.AGREEMENT_REVOKED,
        resourceType: "OperatorAgreement",
        resourceId: agreement.id,
        details: {
          clinicTenantId: existing.clinicTenantId,
          operatorTenantId: existing.operatorTenantId,
          // Which side walked away. The two cases mean very different things to a reviewer, and
          // `revokedByUserId` alone does not distinguish them without a second lookup.
          revokedByTenantId: revokerTenantId,
          revokedByClinic: revokerTenantId === existing.clinicTenantId,
        },
      })
    );

    return agreement;
  }
}
