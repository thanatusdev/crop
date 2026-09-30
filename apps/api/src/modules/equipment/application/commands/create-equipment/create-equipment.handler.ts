import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { EncryptionService } from "../../../../../shared/infrastructure/crypto/encryption.service.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { UNIT_REPOSITORY, type UnitRepositoryPort } from "../../../../units/application/ports/unit-repository.port.js";
import { Equipment } from "../../../domain/equipment.entity.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { CreateEquipmentCommand } from "./create-equipment.command.js";

const DEFAULT_UNIT_NAME = "Unidade Principal";

@CommandHandler(CreateEquipmentCommand)
export class CreateEquipmentHandler implements ICommandHandler<CreateEquipmentCommand, Equipment> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepositoryPort,
    private readonly encryption: EncryptionService,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: CreateEquipmentCommand): Promise<Equipment> {
    const { equipment: input } = command;
    const unitId = await this.resolveUnitId(command.tenantId, input.unitId);

    // PiKVM credentials are encrypted the moment they leave this handler and are never
    // persisted, logged, or returned in plaintext again -- see EncryptionService.
    const equipment = await this.equipment.create({
      tenantId: command.tenantId,
      unitId,
      name: input.name,
      modality: input.modality,
      brand: input.brand,
      model: input.model,
      serialNumber: input.serialNumber,
      roomLabel: input.roomLabel,
      installedAt: input.installedAt,
      aeTitle: input.aeTitle,
      dicomIp: input.dicomIp,
      dicomPort: input.dicomPort,
      pikvmHost: input.pikvmHost,
      pikvmUser: input.pikvmUser,
      pikvmPasswordCiphertext: this.encryption.encrypt(input.pikvmPassword),
      pikvmTotpSecretCiphertext: input.pikvmTotpSecret ? this.encryption.encrypt(input.pikvmTotpSecret) : null,
      targetOs: input.targetOs,
      keymap: input.keymap,
      mouseMode: input.mouseMode,
      screenWidth: input.screenWidth,
      screenHeight: input.screenHeight,
      cameraUrl: input.cameraUrl,
    });

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.EQUIPMENT_CREATED,
        resourceType: "Equipment",
        resourceId: equipment.id,
        // Never the PiKVM credentials -- identification fields only, mirroring every other
        // audit entry in this codebase that carefully excludes secrets/PHI from `details`.
        // The serial number is included deliberately: it is the one value that ties this row
        // to a physical device in an external calibration/asset record, which is exactly what
        // someone auditing "when did this scanner enter the fleet" needs. It is an equipment
        // identifier, not personal data.
        details: {
          name: equipment.name,
          modality: equipment.modality,
          serialNumber: equipment.serialNumber,
          targetOs: equipment.targetOs,
          unitId: equipment.unitId,
        },
      })
    );

    return equipment;
  }

  /**
   * A new Equipment row is never left with a null `unitId` (see schema.prisma's own
   * comment on the column) -- unlike an *explicit* `unitId`, which must belong to this
   * exact tenant or the request is rejected, an *omitted* one is filled in automatically:
   * the tenant's oldest unit, or a freshly created "Unidade Principal" if it has none yet
   * (a brand-new clinic tenant created after the units migration shipped starts with zero
   * units -- only pre-existing tenants got one backfilled).
   */
  private async resolveUnitId(tenantId: string, requestedUnitId: string | null): Promise<string> {
    if (requestedUnitId) {
      const unit = await this.units.findById(requestedUnitId);
      if (!unit) throw new NotFoundError("Unit", requestedUnitId);
      if (unit.clinicTenantId !== tenantId) {
        throw new ForbiddenError(`Unit ${requestedUnitId} does not belong to this tenant`);
      }
      return unit.id;
    }

    const existing = await this.units.listByClinic(tenantId);
    if (existing.length > 0) {
      const oldest = existing.reduce((a, b) => (a.createdAt.getTime() <= b.createdAt.getTime() ? a : b));
      return oldest.id;
    }

    const created = await this.units.create({ clinicTenantId: tenantId, name: DEFAULT_UNIT_NAME });
    return created.id;
  }
}
