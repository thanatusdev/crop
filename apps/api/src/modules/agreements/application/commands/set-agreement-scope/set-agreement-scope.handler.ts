import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../../../access/application/ports/agreement-repository.port.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { OperatorAgreement } from "../../../../access/domain/operator-agreement.entity.js";
import { SetAgreementScopeCommand } from "./set-agreement-scope.command.js";

/**
 * Replaces what an agreement covers. Clinic-only (`assertScopeCanBeSetBy`) -- the operating company
 * is the party being limited, so letting it widen its own scope would make the limit meaningless.
 *
 * Whole-set replacement rather than add/remove: two clinic admins editing concurrently would
 * otherwise need conflict semantics nobody has specified, and "these are the rooms you may operate"
 * is the statement a clinic actually wants to make. An empty payload is a legal way to say "nothing"
 * -- which, combined with the deny-by-default reading of an empty scope, is also the fastest way to
 * suspend an operator without ending the contract.
 */
@CommandHandler(SetAgreementScopeCommand)
export class SetAgreementScopeHandler implements ICommandHandler<SetAgreementScopeCommand, OperatorAgreement> {
  constructor(
    @Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: SetAgreementScopeCommand): Promise<OperatorAgreement> {
    const existing = await this.agreements.findById(command.agreementId);
    if (!existing) throw new NotFoundError("OperatorAgreement", command.agreementId);

    const actorTenantId = command.actor.homeTenantId ?? command.actor.tenantId;
    existing.assertScopeCanBeSetBy(actorTenantId);

    const previousScopeCount = existing.scopes.length;
    // The repository re-validates that every target belongs to this clinic, inside the transaction.
    // That check is not duplicated here: this table *is* the authorization data, so it belongs at
    // the write boundary where no caller can bypass it.
    const agreement = await this.agreements.replaceScope(existing.id, existing.clinicTenantId, [
      ...command.unitIds.map((unitId) => ({ unitId })),
      ...command.equipmentIds.map((equipmentId) => ({ equipmentId })),
    ]);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: existing.clinicTenantId,
        userId: command.actor.sub,
        sessionId: null,
        action: AuditAction.AGREEMENT_SCOPE_CHANGED,
        resourceType: "OperatorAgreement",
        resourceId: agreement.id,
        details: {
          clinicTenantId: existing.clinicTenantId,
          operatorTenantId: existing.operatorTenantId,
          // Ids, never names: the same PHI-adjacent minimalism every other audit row in this
          // codebase follows (see QUEUE_REORDERED, which records entry ids and not patient names).
          unitIds: command.unitIds,
          equipmentIds: command.equipmentIds,
          previousScopeCount,
          newScopeCount: agreement.scopes.length,
        },
      })
    );

    return agreement;
  }
}
