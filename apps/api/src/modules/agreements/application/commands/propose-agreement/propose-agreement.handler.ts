import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AgreementStatus, AuditAction, TenantType } from "@crop/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../../../access/application/ports/agreement-repository.port.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import { OperatorAgreement } from "../../../../access/domain/operator-agreement.entity.js";
import { ProposeAgreementCommand } from "./propose-agreement.command.js";

/**
 * Opens a contract between a clinic and an operating company. Either side may propose; the other
 * accepts (see `RespondToAgreementHandler`).
 *
 * **The proposer's own side comes from their token, never from the request body.** The body names
 * only the counterparty, and which field it may name is decided by the caller's own tenant type.
 * That is what stops an operator admin from proposing a contract "from" some other operating
 * company to a clinic, which would let them manufacture a pending agreement the clinic might
 * reasonably accept believing it came from a company it had been talking to.
 */
@CommandHandler(ProposeAgreementCommand)
export class ProposeAgreementHandler implements ICommandHandler<ProposeAgreementCommand, OperatorAgreement> {
  constructor(
    @Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort,
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: ProposeAgreementCommand): Promise<OperatorAgreement> {
    // The proposer's own tenant is their *home* tenant, not whatever they are currently switched
    // into: an operator admin managing contracts acts for their own company even while working
    // inside a clinic's context.
    const proposerTenantId = command.actor.homeTenantId ?? command.actor.tenantId;
    const proposer = await this.tenants.findById(proposerTenantId);
    if (!proposer) throw new NotFoundError("Tenant", proposerTenantId);

    const counterparty = await this.tenants.findById(command.counterpartyTenantId);
    if (!counterparty) throw new NotFoundError("Tenant", command.counterpartyTenantId);

    // Derive the two sides from the tenant *types*, so a clinic always ends up in
    // `clinicTenantId` and a company in `operatorTenantId` regardless of who proposed.
    let clinicTenantId: string;
    let operatorTenantId: string;
    if (proposer.type === TenantType.CLINIC && counterparty.type === TenantType.OPERATOR_PROVIDER) {
      clinicTenantId = proposer.id;
      operatorTenantId = counterparty.id;
    } else if (proposer.type === TenantType.OPERATOR_PROVIDER && counterparty.type === TenantType.CLINIC) {
      clinicTenantId = counterparty.id;
      operatorTenantId = proposer.id;
    } else {
      throw new ForbiddenError("An agreement is always between one CLINIC and one OPERATOR_PROVIDER tenant");
    }

    // A deactivated party cannot enter a contract. Checked for both sides, not just the clinic: a
    // shut-down operating company must not acquire new engagements either.
    if (proposer.isDeactivated() || counterparty.isDeactivated()) {
      throw new ForbiddenError("A deactivated tenant cannot enter into an agreement");
    }

    const existing = await this.agreements.findByPair(clinicTenantId, operatorTenantId);
    let agreement: OperatorAgreement;
    if (!existing) {
      agreement = await this.agreements.create({
        clinicTenantId,
        operatorTenantId,
        proposedByTenantId: proposerTenantId,
        proposedByUserId: command.actor.sub,
      });
    } else if (existing.status === AgreementStatus.PENDING) {
      // Not an error worth inventing a second row for, and not silently "fine" either: someone is
      // waiting on a response that already exists, and telling them so is more useful than
      // resetting the clock on it.
      throw new ConflictError("An agreement between these two tenants is already awaiting a response");
    } else if (existing.status === AgreementStatus.ACTIVE) {
      throw new ConflictError("These two tenants already have an active agreement");
    } else {
      // REJECTED or REVOKED -- re-opened on the same row rather than inserted again, which is what
      // keeps "has this company ever been contracted here" answerable from one place. See the
      // model's own comment in schema.prisma.
      agreement = await this.agreements.reopenAsPending(existing.id, proposerTenantId, command.actor.sub);
    }

    // Initial scope, if the proposer supplied any. Only meaningful when the *clinic* proposes --
    // scope is the clinic's to set (see `OperatorAgreement.assertScopeCanBeSetBy`), so an operating
    // company naming units in its own proposal would be asking for access rather than granting it,
    // and silently applying that would let it scope itself.
    if ((command.unitIds.length > 0 || command.equipmentIds.length > 0) && proposerTenantId === clinicTenantId) {
      agreement = await this.agreements.replaceScope(agreement.id, clinicTenantId, [
        ...command.unitIds.map((unitId) => ({ unitId })),
        ...command.equipmentIds.map((equipmentId) => ({ equipmentId })),
      ]);
    }

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        // Against the *clinic*, always -- see the AGREEMENT_* actions' own comment in enums.ts: the
        // clinic is the party whose data access is changing, and its audit log is where a reviewer
        // looks to answer "who could see our patients, and since when".
        tenantId: clinicTenantId,
        userId: command.actor.sub,
        sessionId: null,
        action: AuditAction.AGREEMENT_PROPOSED,
        resourceType: "OperatorAgreement",
        resourceId: agreement.id,
        details: {
          clinicTenantId,
          operatorTenantId,
          proposedByTenantId: proposerTenantId,
          reopened: existing !== null,
        },
      })
    );

    return agreement;
  }
}
