import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  CreateUnitRequestSchema,
  UpdateUnitRequestSchema,
  UserRole,
  type AccessTokenClaims,
  type CreateUnitRequest,
  type UpdateUnitRequest,
} from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../iam/presentation/guards/roles.guard.js";
import { Roles } from "../../iam/presentation/decorators/roles.decorator.js";
import { CurrentUser } from "../../iam/presentation/decorators/current-user.decorator.js";
import { CreateUnitCommand } from "../application/commands/create-unit/create-unit.command.js";
import { UpdateUnitCommand } from "../application/commands/update-unit/update-unit.command.js";
import { SetUnitDeactivatedCommand } from "../application/commands/set-unit-deactivated/set-unit-deactivated.command.js";
import { ListUnitsByClinicQuery } from "../application/queries/list-units-by-clinic/list-units-by-clinic.query.js";
import { ListAccessibleUnitsQuery } from "../application/queries/list-accessible-units/list-accessible-units.query.js";
import { GetUnitQuery } from "../application/queries/get-unit/get-unit.query.js";
import { ListTechnicalManagerOptionsQuery } from "../application/queries/list-technical-manager-options/list-technical-manager-options.query.js";
import { toUnitDto } from "./unit.dto.js";

/**
 * Reads (`GET`) are open to any authenticated role, scoped by `ClinicAccessChecker` inside
 * each handler rather than by a class-level `@Roles` -- the same split `EquipmentController`
 * uses, and for the same reason: an OPERATOR needs to see which units exist to pick one, but
 * only clinic-administration roles provision them.
 *
 * Writes are `PLATFORM_ADMIN`, `CLINIC_ADMIN`, `LOCAL_SUPERVISOR`, `LOCAL_IT`. Two changes
 * from the original set, both consequences of the role-model inversion (see roles.ts):
 *   - `LOCAL_SUPERVISOR` added: the supervisor "can do everything except create other
 *     managers or supervisors", and provisioning units is squarely inside that.
 *   - `OPERATOR_ADMIN` removed: a unit belongs to the clinic that owns it, and the clinic is
 *     the party that registers it. An operating company reaches a clinic's units through an
 *     accepted agreement, for *reading and operating* -- not for provisioning. Note this
 *     leaves `ClinicAccessChecker`'s operator-link branch reachable only from the open `GET`
 *     routes now, which is strictly tighter than before, not a gap.
 */
@Controller("units")
@UseGuards(JwtAuthGuard, RolesGuard)
export class UnitsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus
  ) {}

  @Post()
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT)
  async create(@CurrentUser() user: AccessTokenClaims, @Body(new ZodValidationPipe(CreateUnitRequestSchema)) body: CreateUnitRequest) {
    const clinicTenantId = body.clinicTenantId ?? user.tenantId;
    const enriched = await this.commandBus.execute(
      new CreateUnitCommand(
        clinicTenantId,
        {
          name: body.name,
          establishmentType: body.establishmentType,
          technicalManagerId: body.technicalManagerId,
          declaredModalities: body.declaredModalities,
          zipCode: body.zipCode,
          street: body.street,
          number: body.number,
          complement: body.complement ?? null,
          district: body.district,
          city: body.city,
          state: body.state,
          cnesCode: body.cnesCode ?? null,
          phone: body.phone ?? null,
          technicalEmail: body.technicalEmail ?? null,
        },
        user.sub,
        user.tenantId,
        user.role
      )
    );
    return toUnitDto(enriched);
  }

  /**
   * `?scope=all` lists every unit across every clinic the caller can reach (the listing
   * screen's "Todas as Clínicas" option); the default stays exactly what it always was --
   * one clinic, defaulting to the caller's own -- because `ConsoleShell`'s unit-count
   * badge, `EquipmentFormPage`'s unit picker, and `AdminEquipmentPage`'s unit filter all
   * depend on that default and none of them want units from clinics they aren't looking at.
   */
  @Get()
  async list(@CurrentUser() user: AccessTokenClaims, @Query("clinicTenantId") clinicTenantId?: string, @Query("scope") scope?: string) {
    if (scope === "all") {
      const enriched = await this.queryBus.execute(new ListAccessibleUnitsQuery(user.sub, user.tenantId, user.role, user));
      return enriched.map(toUnitDto);
    }

    const targetClinicTenantId = clinicTenantId ?? user.tenantId;
    const enriched = await this.queryBus.execute(new ListUnitsByClinicQuery(targetClinicTenantId, user.sub, user.tenantId, user.role, user));
    return enriched.map(toUnitDto);
  }

  // Declared before `:id` -- Nest matches routes in declaration order, and `:id` would
  // otherwise swallow this path (matching it as `id = "technical-managers"`).
  @Get("technical-managers")
  async listTechnicalManagers(@CurrentUser() user: AccessTokenClaims, @Query("clinicTenantId") clinicTenantId?: string) {
    const targetClinicTenantId = clinicTenantId ?? user.tenantId;
    return this.queryBus.execute(new ListTechnicalManagerOptionsQuery(targetClinicTenantId, user.sub, user.tenantId, user.role));
  }

  @Get(":id")
  async getOne(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    const enriched = await this.queryBus.execute(new GetUnitQuery(id, user.sub, user.tenantId, user.role, user));
    return toUnitDto(enriched);
  }

  @Patch(":id")
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT)
  async update(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateUnitRequestSchema)) body: UpdateUnitRequest
  ) {
    const enriched = await this.commandBus.execute(
      new UpdateUnitCommand(id, { userId: user.sub, tenantId: user.tenantId, role: user.role }, body)
    );
    return toUnitDto(enriched);
  }

  /**
   * The listing screen's "delete" action. No `DELETE /units/:id` exists, deliberately --
   * see `SetUnitDeactivatedHandler`'s own docstring for why (the real foreign key from
   * `Equipment.unitId`, and the audit trail it would otherwise have to reconcile).
   */
  @Post(":id/deactivate")
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT)
  async deactivate(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    const enriched = await this.commandBus.execute(
      new SetUnitDeactivatedCommand(id, { userId: user.sub, tenantId: user.tenantId, role: user.role }, true)
    );
    return toUnitDto(enriched);
  }

  @Post(":id/reactivate")
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT)
  async reactivate(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    const enriched = await this.commandBus.execute(
      new SetUnitDeactivatedCommand(id, { userId: user.sub, tenantId: user.tenantId, role: user.role }, false)
    );
    return toUnitDto(enriched);
  }
}
