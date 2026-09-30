import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { ClinicAccessChecker } from "../../clinic-access-checker.js";
import { UnitEnrichmentService, type EnrichedUnit } from "../../unit-enrichment.service.js";
import { UNIT_REPOSITORY, type UnitRepositoryPort } from "../../ports/unit-repository.port.js";
import { SetUnitDeactivatedCommand } from "./set-unit-deactivated.command.js";

/**
 * Takes a unit out of service, or returns it. This is the listing screen's "delete" action
 * -- there is no hard delete for units and there should not be: `Equipment.unitId` is a
 * real foreign key into this table, and unlike Equipment's own retirement, deactivating a
 * unit doesn't just stop new sessions on *its* equipment -- it's the reason
 * `StartSessionHandler` now also checks the equipment's *unit*, not just the equipment
 * itself, before allowing a session (see that handler's own comment on the cascade). See
 * `SetEquipmentDeactivatedHandler` for the identical reasoning applied one level down.
 *
 * Deliberately does not touch the unit's equipment rows at all: a device keeps its own
 * independent `deactivatedAt`, and reactivating the unit later must not have silently
 * un-retired equipment an admin retired for an unrelated reason in between.
 */
@CommandHandler(SetUnitDeactivatedCommand)
export class SetUnitDeactivatedHandler implements ICommandHandler<SetUnitDeactivatedCommand, EnrichedUnit> {
  constructor(
    private readonly clinicAccess: ClinicAccessChecker,
    private readonly enrichment: UnitEnrichmentService,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: SetUnitDeactivatedCommand): Promise<EnrichedUnit> {
    const existing = await this.units.findById(command.unitId);
    if (!existing) throw new NotFoundError("Unit", command.unitId);
    await this.clinicAccess.assertCanAccessClinic(existing.clinicTenantId, command.actor);

    // Idempotent, and silently so -- same reasoning as SetEquipmentDeactivatedHandler's own
    // guard: a double-click or a stale list still showing the old state doesn't deserve an
    // error, and the audit trail should record transitions, not clicks.
    if (existing.isDeactivated() === command.deactivated) {
      return this.enrichment.enrichOne(existing);
    }

    const updated = await this.units.setDeactivated(existing.id, command.deactivated);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: existing.clinicTenantId,
        userId: command.actor.userId,
        sessionId: null,
        action: command.deactivated ? AuditAction.UNIT_DEACTIVATED : AuditAction.UNIT_REACTIVATED,
        resourceType: "Unit",
        resourceId: existing.id,
        details: { name: existing.name },
      })
    );

    return this.enrichment.enrichOne(updated);
  }
}
