import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { EncryptionService } from "../../../../../shared/infrastructure/crypto/encryption.service.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { Equipment } from "../../../domain/equipment.entity.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { CreateEquipmentCommand } from "./create-equipment.command.js";

@CommandHandler(CreateEquipmentCommand)
export class CreateEquipmentHandler implements ICommandHandler<CreateEquipmentCommand, Equipment> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly encryption: EncryptionService,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: CreateEquipmentCommand): Promise<Equipment> {
    // PiKVM credentials are encrypted the moment they leave this handler and are never
    // persisted, logged, or returned in plaintext again -- see EncryptionService.
    const equipment = await this.equipment.create({
      tenantId: command.tenantId,
      name: command.name,
      pikvmHost: command.pikvmHost,
      pikvmUser: command.pikvmUser,
      pikvmPasswordCiphertext: this.encryption.encrypt(command.pikvmPassword),
      pikvmTotpSecretCiphertext: command.pikvmTotpSecret ? this.encryption.encrypt(command.pikvmTotpSecret) : null,
      targetOs: command.targetOs,
      keymap: command.keymap,
      mouseMode: command.mouseMode,
      screenWidth: command.screenWidth,
      screenHeight: command.screenHeight,
      cameraUrl: command.cameraUrl,
    });

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.EQUIPMENT_CREATED,
        resourceType: "Equipment",
        resourceId: equipment.id,
        // Never the PiKVM credentials -- name/targetOs only, mirroring every other audit
        // entry in this codebase that carefully excludes secrets/PHI from `details`.
        details: { name: equipment.name, targetOs: equipment.targetOs },
      })
    );

    return equipment;
  }
}

