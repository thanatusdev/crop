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
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN)
  async create(
    @CurrentUser() user: AccessTokenClaims,
    @Body(new ZodValidationPipe(CreateEquipmentRequestSchema)) body: CreateEquipmentRequest
  ) {
    const equipment = await this.commandBus.execute(
      new CreateEquipmentCommand(
        user.tenantId,
        user.sub,
        body.name,
        body.pikvmHost,
        body.pikvmUser,
        body.pikvmPassword,
        body.targetOs,
        body.keymap,
        body.mouseMode,
        body.screenWidth,
        body.screenHeight,
        body.cameraUrl ?? null
      )
    );
    return toEquipmentDto(equipment);
  }

  @Get()
  async list(@CurrentUser() user: AccessTokenClaims) {
    const equipment = await this.queryBus.execute(new ListEquipmentQuery(user.tenantId));
    return equipment.map(toEquipmentDto);
  }

  @Get(":id")
  async getOne(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    const equipment = await this.queryBus.execute(new GetEquipmentQuery(id, user.tenantId));
    return toEquipmentDto(equipment);
  }

  @Patch(":id")
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN)
  async update(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateEquipmentRequestSchema)) body: UpdateEquipmentRequest
  ) {
    const equipment = await this.commandBus.execute(new UpdateEquipmentCommand(id, user.tenantId, user.sub, body));
    return toEquipmentDto(equipment);
  }

  @Post(":id/maintenance")
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async enterMaintenance(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string): Promise<void> {
    await this.commandBus.execute(new EnterMaintenanceCommand(id, user.tenantId, user.sub));
  }

  @Post(":id/maintenance/clear")
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearMaintenance(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string): Promise<void> {
    await this.commandBus.execute(new ClearMaintenanceCommand(id, user.tenantId, user.sub));
  }
}
