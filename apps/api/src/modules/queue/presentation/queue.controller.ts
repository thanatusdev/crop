import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  CreateQueueEntryRequestSchema,
  UpdateQueueStatusRequestSchema,
  type AccessTokenClaims,
  type CreateQueueEntryRequest,
  type UpdateQueueStatusRequest,
} from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { CurrentUser } from "../../iam/presentation/decorators/current-user.decorator.js";
import { CreateQueueEntryCommand } from "../application/commands/create-queue-entry/create-queue-entry.command.js";
import { UpdateQueueStatusCommand } from "../application/commands/update-queue-status/update-queue-status.command.js";
import { ListQueueByEquipmentQuery } from "../application/queries/list-queue-by-equipment/list-queue-by-equipment.query.js";
import { toQueueEntryDto } from "./queue.dto.js";

@Controller("queue")
@UseGuards(JwtAuthGuard)
export class QueueController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus
  ) {}

  @Post()
  async create(
    @CurrentUser() user: AccessTokenClaims,
    @Body(new ZodValidationPipe(CreateQueueEntryRequestSchema)) body: CreateQueueEntryRequest
  ) {
    const entry = await this.commandBus.execute(
      new CreateQueueEntryCommand(
        user.tenantId,
        user.sub,
        body.equipmentId,
        body.patientFirstName,
        body.scheduledAt ? new Date(body.scheduledAt) : null
      )
    );
    return toQueueEntryDto(entry);
  }

  @Get()
  async list(@CurrentUser() user: AccessTokenClaims, @Query("equipmentId") equipmentId: string) {
    const entries = await this.queryBus.execute(new ListQueueByEquipmentQuery(equipmentId, user.tenantId));
    return entries.map(toQueueEntryDto);
  }

  @Post(":id/status")
  async updateStatus(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateQueueStatusRequestSchema)) body: UpdateQueueStatusRequest
  ) {
    await this.commandBus.execute(new UpdateQueueStatusCommand(user.tenantId, user.sub, id, body.status));
  }
}

