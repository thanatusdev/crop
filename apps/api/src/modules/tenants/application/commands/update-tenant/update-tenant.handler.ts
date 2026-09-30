import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { ResponsibleManagerValidator } from "../../responsible-manager-validator.js";
import { TenantEnrichmentService, type EnrichedTenant } from "../../tenant-enrichment.service.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../ports/tenant-repository.port.js";
import { UpdateTenantCommand } from "./update-tenant.command.js";

@CommandHandler(UpdateTenantCommand)
export class UpdateTenantHandler implements ICommandHandler<UpdateTenantCommand, EnrichedTenant> {
  constructor(
    private readonly responsibleManagers: ResponsibleManagerValidator,
    private readonly enrichment: TenantEnrichmentService,
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: UpdateTenantCommand): Promise<EnrichedTenant> {
    const existing = await this.tenants.findById(command.tenantId);
    if (!existing) throw new NotFoundError("Tenant", command.tenantId);

    if (command.changes.responsibleManagerId) {
      await this.responsibleManagers.assertEligible(command.changes.responsibleManagerId, existing.id);
    }

    const updated = await this.tenants.update(existing.id, command.changes);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: existing.id,
        userId: command.actingAdminId,
        sessionId: null,
        action: AuditAction.TENANT_UPDATED,
        resourceType: "Tenant",
        resourceId: existing.id,
        // Field *names* only -- same flat rule EQUIPMENT_UPDATED/UNIT_UPDATED's own audit
        // entries already follow, for the same reason: simpler to keep correct than judging
        // each field as sensitive or not, case by case, as new ones get added later.
        details: { changedFields: Object.keys(command.changes) },
      })
    );

    return this.enrichment.enrichOne(updated);
  }
}
