import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  CreateEquipmentRequestSchema,
  UpdateEquipmentRequestSchema,
  UserRole,
  type AccessTokenClaims,
  type CreateEquipmentRequest,
  type UpdateEquipmentRequest,
} from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../iam/presentation/guards/roles.guard.js";
import { Roles } from "../../iam/presentation/decorators/roles.decorator.js";
import { CurrentUser } from "../../iam/presentation/decorators/current-user.decorator.js";
import { CreateEquipmentCommand } from "../application/commands/create-equipment/create-equipment.command.js";
import { UpdateEquipmentCommand } from "../application/commands/update-equipment/update-equipment.command.js";
import { SetEquipmentDeactivatedCommand } from "../application/commands/set-equipment-deactivated/set-equipment-deactivated.command.js";
import { EnterMaintenanceCommand } from "../application/commands/enter-maintenance/enter-maintenance.command.js";
import { ClearMaintenanceCommand } from "../application/commands/clear-maintenance/clear-maintenance.command.js";
import { ListEquipmentQuery } from "../application/queries/list-equipment/list-equipment.query.js";
import { GetEquipmentQuery } from "../application/queries/get-equipment/get-equipment.query.js";
import { toEquipmentDto } from "./equipment.dto.js";

@Controller("equipment")
@UseGuards(JwtAuthGuard, RolesGuard)
export class EquipmentController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus
  ) {}

  @Post()
  // Writes are the clinic-administration roles only: a scanner belongs to the clinic that
  // owns it, and the clinic registers it. `LOCAL_IT` is a clinic's own technical staff, who
  // provision and maintain equipment day-to-day (including the PiKVM console config).
  // `LOCAL_SUPERVISOR` joined alongside the widened clinic-side grants, and `OPERATOR_ADMIN`
  // left, when operator-side roles became OPERATOR_PROVIDER-only -- see
  // packages/shared/src/roles.ts and UnitsController's own docstring, which makes the
  // identical change for the identical reason. Reads stay open to any authenticated role
  // (tenant-scoped inside the handlers) so an operator can pick a room to work.
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT)
  async create(
    @CurrentUser() user: AccessTokenClaims,
    @Body(new ZodValidationPipe(CreateEquipmentRequestSchema)) body: CreateEquipmentRequest
  ) {
    const equipment = await this.commandBus.execute(
      new CreateEquipmentCommand(user.tenantId, user.sub, {
        name: body.name,
        unitId: body.unitId ?? null,
        modality: body.modality,
        brand: body.brand,
        model: body.model,
        serialNumber: body.serialNumber,
        roomLabel: body.roomLabel,
        installedAt: body.installedAt,
        // The request schema marks these `.optional()` (absent = not recorded), while the
        // command models them as explicitly nullable -- normalized here rather than letting
        // `undefined` reach the persistence layer, where Prisma would read it as "leave
        // unchanged" instead of "no value," a distinction that matters on update and is worth
        // keeping consistent on create.
        aeTitle: body.aeTitle ?? null,
        dicomIp: body.dicomIp ?? null,
        dicomPort: body.dicomPort ?? null,
        pikvmHost: body.pikvmHost,
        pikvmUser: body.pikvmUser,
        pikvmPassword: body.pikvmPassword,
        pikvmTotpSecret: null,
        targetOs: body.targetOs,
        keymap: body.keymap,
        mouseMode: body.mouseMode,
        screenWidth: body.screenWidth,
        screenHeight: body.screenHeight,
        cameraUrl: body.cameraUrl ?? null,
      })
    );
    return toEquipmentDto(equipment);
  }

  @Get()
  async list(@CurrentUser() user: AccessTokenClaims) {
    const equipment = await this.queryBus.execute(new ListEquipmentQuery(user.tenantId, user));
    return equipment.map(toEquipmentDto);
  }

  @Get(":id")
  async getOne(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    const equipment = await this.queryBus.execute(new GetEquipmentQuery(id, user.tenantId, user));
    return toEquipmentDto(equipment);
  }

  @Patch(":id")
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT)
  async update(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateEquipmentRequestSchema)) body: UpdateEquipmentRequest
  ) {
    const equipment = await this.commandBus.execute(new UpdateEquipmentCommand(id, user.tenantId, user.sub, body));
    return toEquipmentDto(equipment);
  }

  @Post(":id/maintenance")
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT)
  @HttpCode(HttpStatus.NO_CONTENT)
  async enterMaintenance(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string): Promise<void> {
    await this.commandBus.execute(new EnterMaintenanceCommand(id, user.tenantId, user.sub));
  }

  @Post(":id/maintenance/clear")
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT)
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearMaintenance(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string): Promise<void> {
    await this.commandBus.execute(new ClearMaintenanceCommand(id, user.tenantId, user.sub));
  }

  /**
   * Retire a scanner from service. This is the listing screen's "delete" action: there is no
   * `DELETE /equipment/:id` and there deliberately isn't one -- Session/QueueEntry rows carry
   * real foreign keys to equipment and feed the append-only audit trail, so a hard delete
   * would either be rejected by those constraints or destroy the history the trail exists to
   * keep. See SetEquipmentDeactivatedHandler for why an in-flight session is left alone.
   *
   * Modelled as two verbs rather than one `PATCH` with a boolean for the same reason
   * maintenance is (above) and tenant deactivation is: the caller states an intent, and the
   * handler's idempotency guard means a repeated click is a no-op instead of a toggle that
   * silently does the opposite of what the operator expected against a stale list.
   */
  @Post(":id/deactivate")
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT)
  async deactivate(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    const equipment = await this.commandBus.execute(new SetEquipmentDeactivatedCommand(id, user.tenantId, user.sub, true));
    return toEquipmentDto(equipment);
  }

  @Post(":id/reactivate")
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT)
  async reactivate(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    const equipment = await this.commandBus.execute(new SetEquipmentDeactivatedCommand(id, user.tenantId, user.sub, false));
    return toEquipmentDto(equipment);
  }
}
