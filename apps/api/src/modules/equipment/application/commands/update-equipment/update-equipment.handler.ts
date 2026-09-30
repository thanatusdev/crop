import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { EncryptionService } from "../../../../../shared/infrastructure/crypto/encryption.service.js";
import { UNIT_REPOSITORY, type UnitRepositoryPort } from "../../../../units/application/ports/unit-repository.port.js";
import { Equipment } from "../../../domain/equipment.entity.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort, type UpdateEquipmentData } from "../../ports/equipment-repository.port.js";
import { UpdateEquipmentCommand } from "./update-equipment.command.js";

@CommandHandler(UpdateEquipmentCommand)
export class UpdateEquipmentHandler implements ICommandHandler<UpdateEquipmentCommand, Equipment> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepositoryPort,
    private readonly encryption: EncryptionService,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: UpdateEquipmentCommand): Promise<Equipment> {
    const existing = await this.equipment.findById(command.equipmentId);
    if (!existing) throw new NotFoundError("Equipment", command.equipmentId);
    if (!existing.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Equipment does not belong to your tenant");
    }

    // Same validation CreateEquipmentHandler applies to an explicit unitId -- reassigning
    // equipment to a unit outside its own tenant would silently break every
    // `belongsToTenant` check elsewhere, since `tenantId` is what those still key on.
    if (command.changes.unitId) {
      const unit = await this.units.findById(command.changes.unitId);
      if (!unit) throw new NotFoundError("Unit", command.changes.unitId);
      if (unit.clinicTenantId !== existing.tenantId) {
        throw new ForbiddenError(`Unit ${command.changes.unitId} does not belong to this tenant`);
      }
    }

    const { pikvmPassword, ...rest } = command.changes;
    const data: UpdateEquipmentData = { ...rest };
    // Blank/absent means "leave the stored credential unchanged" -- this key is only ever
    // set on the update payload when a real new password was actually provided, matching
    // AdminResetPasswordRequestSchema's identical convention for users.
    if (pikvmPassword) {
      data.pikvmPasswordCiphertext = this.encryption.encrypt(pikvmPassword);
    }

    const updated = await this.equipment.update(existing.id, data);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: existing.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.EQUIPMENT_UPDATED,
        resourceType: "Equipment",
        resourceId: existing.id,
        // Field *names* only, matching EQUIPMENT_CREATED's own precedent of never recording
        // PiKVM credentials -- and for the same reason extended to every other field here
        // too: a value like a changed cameraUrl or screen size isn't sensitive on its own,
        // but there's no benefit to recording it either, and a flat rule ("changed field
        // names, never values") is easier to keep correct than judging each field case by
        // case as new ones get added later.
        details: { changedFields: Object.keys(command.changes) },
      })
    );

    return updated;
  }
}
