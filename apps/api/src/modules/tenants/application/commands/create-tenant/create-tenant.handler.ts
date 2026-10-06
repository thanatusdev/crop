import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, EventBus, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ConflictError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { TenantEnrichmentService, type EnrichedTenant } from "../../tenant-enrichment.service.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../ports/tenant-repository.port.js";
import { TenantCreatedEvent } from "../../events/tenant-created.event.js";
import { CreateTenantCommand } from "./create-tenant.command.js";

@CommandHandler(CreateTenantCommand)
export class CreateTenantHandler implements ICommandHandler<CreateTenantCommand, EnrichedTenant> {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    private readonly enrichment: TenantEnrichmentService,
    private readonly commandBus: CommandBus,
    private readonly eventBus: EventBus
  ) {}

  async execute(command: CreateTenantCommand): Promise<EnrichedTenant> {
    // Friendly pre-check before the insert -- see TenantRepositoryPort.findByCnpj's own
    // docstring for why (the same precedent RegisterUserHandler.findByEmail sets). Only
    // meaningful when a CNPJ was actually supplied; the PLATFORM tenant and any direct
    // CommandBus caller that omitted `tenantDetails` has none.
    if (command.tenantDetails?.cnpj) {
      const existing = await this.tenants.findByCnpj(command.tenantDetails.cnpj);
      if (existing) {
        throw new ConflictError(`A tenant with CNPJ ${command.tenantDetails.cnpj} already exists`);
      }
    }

    const tenant = await this.tenants.create({
      name: command.name,
      type: command.type,
      cnpj: command.tenantDetails?.cnpj ?? null,
      institutionalEmail: command.tenantDetails?.institutionalEmail ?? null,
      phone: command.tenantDetails?.phone ?? null,
      zipCode: command.tenantDetails?.zipCode ?? null,
      street: command.tenantDetails?.street ?? null,
      number: command.tenantDetails?.number ?? null,
      complement: command.tenantDetails?.complement ?? null,
      district: command.tenantDetails?.district ?? null,
      city: command.tenantDetails?.city ?? null,
      state: command.tenantDetails?.state ?? null,
    });

    // Attributed to the *new* tenant, not the acting PLATFORM_ADMIN's own (platform) tenant
    // -- so this shows up in that tenant's own audit history from the moment it exists, the
    // same way every other tenant-scoped event does. No FK constraint requires userId's
    // owner to belong to this tenantId (see AuditLog's schema comment); a platform admin
    // acting across tenants is exactly the case this needs to support.
    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: tenant.id,
        userId: command.actingAdminId,
        sessionId: null,
        action: AuditAction.TENANT_CREATED,
        resourceType: "Tenant",
        resourceId: tenant.id,
        details: { name: tenant.name, type: tenant.type, cnpj: tenant.cnpj },
      })
    );

    this.eventBus.publish(new TenantCreatedEvent(tenant.id, tenant.type));

    return this.enrichment.enrichOne(tenant);
  }
}
