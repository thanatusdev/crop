import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { TenantsController } from "./presentation/tenants.controller.js";
import { TENANT_REPOSITORY } from "./application/ports/tenant-repository.port.js";
import { PrismaTenantRepository } from "./infrastructure/prisma-tenant.repository.js";
import { ResponsibleManagerValidator } from "./application/responsible-manager-validator.js";
import { TenantEnrichmentService } from "./application/tenant-enrichment.service.js";
import { AuditModule } from "../audit/audit.module.js";

import { CreateTenantHandler } from "./application/commands/create-tenant/create-tenant.handler.js";
import { UpdateTenantHandler } from "./application/commands/update-tenant/update-tenant.handler.js";
import { DeactivateTenantHandler } from "./application/commands/deactivate-tenant/deactivate-tenant.handler.js";
import { ReactivateTenantHandler } from "./application/commands/reactivate-tenant/reactivate-tenant.handler.js";
import { ListTenantsHandler } from "./application/queries/list-tenants/list-tenants.handler.js";
import { GetTenantHandler } from "./application/queries/get-tenant/get-tenant.handler.js";
import { ListResponsibleManagerOptionsHandler } from "./application/queries/list-responsible-manager-options/list-responsible-manager-options.handler.js";

const COMMAND_AND_QUERY_HANDLERS = [
  CreateTenantHandler,
  UpdateTenantHandler,
  DeactivateTenantHandler,
  ReactivateTenantHandler,
  ListTenantsHandler,
  GetTenantHandler,
  ListResponsibleManagerOptionsHandler,
];

@Module({
  // Deliberately NOT importing IamModule for USER_REPOSITORY, even though
  // ResponsibleManagerValidator needs to check a candidate's role/activation/lock state:
  // IamModule already imports TenantsModule (for TENANT_REPOSITORY itself, used by
  // LoginHandler/RefreshTokensHandler/RegisterUserHandler), so the reverse import would be a
  // module cycle. See TenantRepositoryPort's own docstring on why that lookup instead goes
  // straight through Prisma inside PrismaTenantRepository -- the exact precedent
  // PrismaUnitRepository already set for the identical shape of problem.
  imports: [CqrsModule, AuditModule],
  controllers: [TenantsController],
  providers: [
    { provide: TENANT_REPOSITORY, useClass: PrismaTenantRepository },
    ResponsibleManagerValidator,
    TenantEnrichmentService,
    ...COMMAND_AND_QUERY_HANDLERS,
  ],
  // Exported so IamModule can inject TENANT_REPOSITORY into LoginHandler/RefreshTokensHandler
  // (tenant-deactivation status), RegisterUserHandler (the role<->tenant-type invariant), and
  // RequestPasswordResetHandler/ResetPasswordHandler (the same deactivation re-check) -- the
  // same cross-module dependency shape SessionsModule already has on QueueModule.
  exports: [TENANT_REPOSITORY],
})
export class TenantsModule {}
