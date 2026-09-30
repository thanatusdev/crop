import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { Equipment } from "../../../domain/equipment.entity.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { SetEquipmentDeactivatedCommand } from "./set-equipment-deactivated.command.js";

/**
 * Retires a scanner from service, or returns it. This is what the listing screen's "delete"
 * action does -- there is no hard delete for equipment and there should not be: `Session` and
 * `QueueEntry` rows hold real foreign keys to it, and those feed the append-only audit trail
 * (see docs/architecture.md), so a DELETE would either fail on those constraints or, if
 * cascaded, destroy exactly the history the audit trail exists to preserve. Same conclusion,
 * and same `deactivatedAt` mechanism, as tenant deactivation.
 *
 * **An in-flight session is deliberately left running.** Deactivation prevents *new* sessions
 * (`Equipment.isAvailableForSession()`); it does not abort one already in progress. Killing a
 * live remote-control session on a clinical device because an administrator clicked a
 * trash-can icon in a different browser tab is the more dangerous behaviour of the two -- the
 * operator could be mid-procedure. The session ends the way every other session ends (an
 * operator ending it, a supervisor aborting it, or the idle timeout), and no new one can be
 * started after that. There is also a structural reason not to do it here: aborting a session
 * would make this module depend on the sessions module, which already depends on this one.
 */
@CommandHandler(SetEquipmentDeactivatedCommand)
export class SetEquipmentDeactivatedHandler implements ICommandHandler<SetEquipmentDeactivatedCommand, Equipment> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: SetEquipmentDeactivatedCommand): Promise<Equipment> {
    const existing = await this.equipment.findById(command.equipmentId);
    if (!existing) throw new NotFoundError("Equipment", command.equipmentId);
    if (!existing.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Equipment does not belong to your tenant");
    }

    // Idempotent, and silently so: deactivating already-deactivated equipment is a no-op
    // rather than an error, because the realistic way to hit it is a double-click or a stale
    // list still showing the old state -- neither deserves an error dialog. The audit write
    // is skipped too, so the trail records transitions rather than clicks (the same reasoning
    // as UpdateEquipmentStatusHandler's own unchanged-status guard).
    if (existing.isDeactivated() === command.deactivated) return existing;

    const updated = await this.equipment.setDeactivated(existing.id, command.deactivated);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: existing.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: command.deactivated ? AuditAction.EQUIPMENT_DEACTIVATED : AuditAction.EQUIPMENT_REACTIVATED,
        resourceType: "Equipment",
        resourceId: existing.id,
        // `lastKnownStatus` is worth recording precisely because the health poller stops
        // updating it from here on: it is the last thing the platform actually observed about
        // the device before it left service, and after this point the stored value is frozen
        // and no longer evidence of anything current.
        details: { name: existing.name, serialNumber: existing.serialNumber, lastKnownStatus: existing.status },
      })
    );

    return updated;
  }
}
