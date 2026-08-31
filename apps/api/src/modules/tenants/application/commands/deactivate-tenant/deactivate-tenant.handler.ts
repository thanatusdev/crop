import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, TenantType } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../ports/tenant-repository.port.js";
import { DeactivateTenantCommand } from "./deactivate-tenant.command.js";

@CommandHandler(DeactivateTenantCommand)
export class DeactivateTenantHandler implements ICommandHandler<DeactivateTenantCommand, void> {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: DeactivateTenantCommand): Promise<void> {
    const tenant = await this.tenants.findById(command.tenantId);
    if (!tenant) throw new NotFoundError("Tenant", command.tenantId);

    // A PLATFORM-type tenant is where every PLATFORM_ADMIN account lives, normally the only
    // one of its kind (see bootstrap-superadmin.ts). Deactivating it would lock out every
    // platform admin at once, including whoever just ran this -- with no UI-reachable way
    // back in, since reactivating requires being logged in as exactly the role this would
    // have just disabled. Refuse outright rather than build a break-glass recovery path for
    // a self-inflicted problem this check prevents for free.
    if (tenant.type === TenantType.PLATFORM) {
      throw new ForbiddenError("Cannot deactivate a PLATFORM-type tenant");
    }

    if (tenant.isDeactivated()) return; // idempotent

    await this.tenants.deactivate(tenant.id);
    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: tenant.id,
        userId: command.actingAdminId,
        sessionId: null,
        action: AuditAction.TENANT_DEACTIVATED,
        resourceType: "Tenant",
        resourceId: tenant.id,
        details: { name: tenant.name },
      })
    );
  }
}
