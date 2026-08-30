import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  CreateQueueEntryRequestSchema,
  UpdateQueueStatusRequestSchema,
  type CreateQueueEntryRequest,
  type UpdateQueueStatusRequest,
} from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
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
  async create(@Body(new ZodValidationPipe(CreateQueueEntryRequestSchema)) body: CreateQueueEntryRequest) {
    const entry = await this.commandBus.execute(
      new CreateQueueEntryCommand(
        body.equipmentId,
        body.patientFirstName,
        body.scheduledAt ? new Date(body.scheduledAt) : null
      )
    );
    return toQueueEntryDto(entry);
  }

  @Get()
  async list(@Query("equipmentId") equipmentId: string) {
    const entries = await this.queryBus.execute(new ListQueueByEquipmentQuery(equipmentId));
    return entries.map(toQueueEntryDto);
  }

  @Post(":id/status")
  async updateStatus(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateQueueStatusRequestSchema)) body: UpdateQueueStatusRequest
  ) {
    await this.commandBus.execute(new UpdateQueueStatusCommand(id, body.status));
  }
}
