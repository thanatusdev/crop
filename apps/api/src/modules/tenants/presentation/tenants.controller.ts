import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  CreateTenantRequestSchema,
  TenantType,
  UpdateTenantRequestSchema,
  UserRole,
  type AccessTokenClaims,
  type CreateTenantRequest,
  type UpdateTenantRequest,
} from "@crop/shared";
import { ValidationError } from "../../../shared/domain/errors.js";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../iam/presentation/guards/roles.guard.js";
import { Roles } from "../../iam/presentation/decorators/roles.decorator.js";
import { CurrentUser } from "../../iam/presentation/decorators/current-user.decorator.js";
import { CreateTenantCommand } from "../application/commands/create-tenant/create-tenant.command.js";
import { UpdateTenantCommand } from "../application/commands/update-tenant/update-tenant.command.js";
import { DeactivateTenantCommand } from "../application/commands/deactivate-tenant/deactivate-tenant.command.js";
import { ReactivateTenantCommand } from "../application/commands/reactivate-tenant/reactivate-tenant.command.js";
import { ListTenantsQuery } from "../application/queries/list-tenants/list-tenants.query.js";
import { GetTenantQuery } from "../application/queries/get-tenant/get-tenant.query.js";
import { ListResponsibleManagerOptionsQuery } from "../application/queries/list-responsible-manager-options/list-responsible-manager-options.query.js";
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
    const enriched = await this.commandBus.execute(
      new CreateTenantCommand(body.name, body.type, admin.sub, {
        // Both CLINIC and OPERATOR_PROVIDER carry these now -- CreateTenantRequestSchema's own
        // `.superRefine` is what actually enforces they're present; PLATFORM is the only type
        // this schema does not even accept, so there is nothing else to branch on here.
        cnpj: body.cnpj ?? null,
        institutionalEmail: body.institutionalEmail ?? null,
        phone: body.phone ?? null,
        zipCode: body.zipCode ?? null,
        street: body.street ?? null,
        number: body.number ?? null,
        complement: body.complement ?? null,
        district: body.district ?? null,
        city: body.city ?? null,
        state: body.state ?? null,
      })
    );
    return toTenantDto(enriched);
  }

  @Get()
  async list(@Query("type") type?: string) {
    // Validated rather than passed through, same reasoning as AgreementsController's own
    // `status` query param: an unrecognised type would otherwise reach Prisma as a bogus enum
    // value and surface as a 500 instead of a 400. PLATFORM is a legal TenantType but never a
    // legal filter value here -- there is exactly one such tenant and no screen lists it.
    if (type !== undefined) {
      if (!(Object.values(TenantType) as string[]).includes(type) || type === TenantType.PLATFORM) {
        throw new ValidationError(`Unknown tenant type: ${type}`);
      }
    }
    const enriched = await this.queryBus.execute(new ListTenantsQuery(type as TenantType | undefined));
    return enriched.map(toTenantDto);
  }

  // Declared before `:id` -- Nest matches routes in declaration order, and `:id` would
  // otherwise swallow this path (matching it as `id = "responsible-manager-options"`), the
  // same footgun `UnitsController`'s own `technical-managers` route already documents.
  @Get("responsible-manager-options")
  async listResponsibleManagers(@Query("tenantId") tenantId: string) {
    return this.queryBus.execute(new ListResponsibleManagerOptionsQuery(tenantId));
  }

  @Get(":id")
  async getOne(@Param("id") id: string) {
    const enriched = await this.queryBus.execute(new GetTenantQuery(id));
    return toTenantDto(enriched);
  }

  @Patch(":id")
  async update(
    @CurrentUser() admin: AccessTokenClaims,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateTenantRequestSchema)) body: UpdateTenantRequest
  ) {
    const enriched = await this.commandBus.execute(new UpdateTenantCommand(id, admin.sub, body));
    return toTenantDto(enriched);
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
