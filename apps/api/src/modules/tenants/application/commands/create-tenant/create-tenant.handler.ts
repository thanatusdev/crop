import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { Tenant } from "../../../domain/tenant.entity.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../ports/tenant-repository.port.js";
import { CreateTenantCommand } from "./create-tenant.command.js";

@CommandHandler(CreateTenantCommand)
export class CreateTenantHandler implements ICommandHandler<CreateTenantCommand, Tenant> {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: CreateTenantCommand): Promise<Tenant> {
    const tenant = await this.tenants.create({ name: command.name, type: command.type });

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
        details: { name: tenant.name, type: tenant.type },
      })
    );

    return tenant;
  }
}
