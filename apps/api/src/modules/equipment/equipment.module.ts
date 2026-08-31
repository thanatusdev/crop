import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { EquipmentController } from "./presentation/equipment.controller.js";
import { EQUIPMENT_REPOSITORY } from "./application/ports/equipment-repository.port.js";
import { PrismaEquipmentRepository } from "./infrastructure/prisma-equipment.repository.js";
import { PiKvmHealthPoller } from "./infrastructure/pikvm-health-poller.service.js";
import { EncryptionService } from "../../shared/infrastructure/crypto/encryption.service.js";
import { AuditModule } from "../audit/audit.module.js";

import { CreateEquipmentHandler } from "./application/commands/create-equipment/create-equipment.handler.js";
import { UpdateEquipmentStatusHandler } from "./application/commands/update-equipment-status/update-equipment-status.handler.js";
import { ListEquipmentHandler } from "./application/queries/list-equipment/list-equipment.handler.js";
import { GetEquipmentHandler } from "./application/queries/get-equipment/get-equipment.handler.js";
import { GetEquipmentConnectionSecretsHandler } from "./application/queries/get-equipment-credentials/get-equipment-connection-secrets.handler.js";

const COMMAND_AND_QUERY_HANDLERS = [
  CreateEquipmentHandler,
  UpdateEquipmentStatusHandler,
  ListEquipmentHandler,
  GetEquipmentHandler,
  GetEquipmentConnectionSecretsHandler,
];

@Module({
  imports: [CqrsModule, AuditModule],
  controllers: [EquipmentController],
  providers: [
    { provide: EQUIPMENT_REPOSITORY, useClass: PrismaEquipmentRepository },
    EncryptionService,
    PiKvmHealthPoller,
    ...COMMAND_AND_QUERY_HANDLERS,
  ],
  exports: [EQUIPMENT_REPOSITORY],
})
export class EquipmentModule {}

