import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { CreateEquipmentRequestSchema, UserRole, type AccessTokenClaims, type CreateEquipmentRequest } from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../iam/presentation/guards/roles.guard.js";
import { Roles } from "../../iam/presentation/decorators/roles.decorator.js";
import { CurrentUser } from "../../iam/presentation/decorators/current-user.decorator.js";
import { CreateEquipmentCommand } from "../application/commands/create-equipment/create-equipment.command.js";
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
}
