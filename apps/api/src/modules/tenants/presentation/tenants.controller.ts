import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { CreateTenantRequestSchema, UserRole, type AccessTokenClaims, type CreateTenantRequest } from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../iam/presentation/guards/roles.guard.js";
import { Roles } from "../../iam/presentation/decorators/roles.decorator.js";
import { CurrentUser } from "../../iam/presentation/decorators/current-user.decorator.js";
import { CreateTenantCommand } from "../application/commands/create-tenant/create-tenant.command.js";
import { DeactivateTenantCommand } from "../application/commands/deactivate-tenant/deactivate-tenant.command.js";
import { ReactivateTenantCommand } from "../application/commands/reactivate-tenant/reactivate-tenant.command.js";
import { ListTenantsQuery } from "../application/queries/list-tenants/list-tenants.query.js";
import { toTenantDto } from "./tenant.dto.js";

/**
 * Tenant lifecycle management -- the first routes in this codebase gated to PLATFORM_ADMIN
 * *alone*, not lumped with CLINIC_ADMIN like every prior `@Roles(...)` list. That's the
 * point: a CLINIC_ADMIN operates within one tenant and every other admin-ish route reflects
 * that; this module is exactly the operations that only make sense *above* any single
 * tenant. No tenant-isolation check exists in the handlers behind these routes, unlike
 * every other module -- there is no "caller's own tenant" to scope against here, by design.
 */
@Controller("tenants")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PLATFORM_ADMIN)
export class TenantsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus
  ) {}

  @Post()
  async create(@CurrentUser() admin: AccessTokenClaims, @Body(new ZodValidationPipe(CreateTenantRequestSchema)) body: CreateTenantRequest) {
    const tenant = await this.commandBus.execute(new CreateTenantCommand(body.name, body.type, admin.sub));
    return toTenantDto(tenant);
  }

  @Get()
  async list() {
    const tenants = await this.queryBus.execute(new ListTenantsQuery());
    return tenants.map(toTenantDto);
  }

  @Post(":id/deactivate")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivate(@CurrentUser() admin: AccessTokenClaims, @Param("id") id: string): Promise<void> {
    await this.commandBus.execute(new DeactivateTenantCommand(id, admin.sub));
  }

  @Post(":id/reactivate")
  @HttpCode(HttpStatus.NO_CONTENT)
  async reactivate(@CurrentUser() admin: AccessTokenClaims, @Param("id") id: string): Promise<void> {
    await this.commandBus.execute(new ReactivateTenantCommand(id, admin.sub));
  }
}
