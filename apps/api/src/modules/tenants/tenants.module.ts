import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { TenantsController } from "./presentation/tenants.controller.js";
import { TENANT_REPOSITORY } from "./application/ports/tenant-repository.port.js";
import { PrismaTenantRepository } from "./infrastructure/prisma-tenant.repository.js";
import { AuditModule } from "../audit/audit.module.js";

import { CreateTenantHandler } from "./application/commands/create-tenant/create-tenant.handler.js";
import { DeactivateTenantHandler } from "./application/commands/deactivate-tenant/deactivate-tenant.handler.js";
import { ReactivateTenantHandler } from "./application/commands/reactivate-tenant/reactivate-tenant.handler.js";
import { ListTenantsHandler } from "./application/queries/list-tenants/list-tenants.handler.js";

const COMMAND_AND_QUERY_HANDLERS = [CreateTenantHandler, DeactivateTenantHandler, ReactivateTenantHandler, ListTenantsHandler];

@Module({
  imports: [CqrsModule, AuditModule],
  controllers: [TenantsController],
  providers: [{ provide: TENANT_REPOSITORY, useClass: PrismaTenantRepository }, ...COMMAND_AND_QUERY_HANDLERS],
  // Exported so IamModule can inject TENANT_REPOSITORY into LoginHandler/RefreshTokensHandler
  // to check tenant-deactivation status -- the same cross-module dependency shape
  // SessionsModule already has on QueueModule.
  exports: [TENANT_REPOSITORY],
})
export class TenantsModule {}
