import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../ports/tenant-repository.port.js";
import { ReactivateTenantCommand } from "./reactivate-tenant.command.js";

@CommandHandler(ReactivateTenantCommand)
export class ReactivateTenantHandler implements ICommandHandler<ReactivateTenantCommand, void> {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: ReactivateTenantCommand): Promise<void> {
    const tenant = await this.tenants.findById(command.tenantId);
    if (!tenant) throw new NotFoundError("Tenant", command.tenantId);

    if (!tenant.isDeactivated()) return; // idempotent

    await this.tenants.reactivate(tenant.id);
    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: tenant.id,
        userId: command.actingAdminId,
        sessionId: null,
        action: AuditAction.TENANT_REACTIVATED,
        resourceType: "Tenant",
        resourceId: tenant.id,
        details: { name: tenant.name },
      })
    );
  }
}
