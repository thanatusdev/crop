import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ConflictError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { ClinicAccessChecker } from "../../clinic-access-checker.js";
import { TechnicalManagerValidator } from "../../technical-manager-validator.js";
import { UnitEnrichmentService, type EnrichedUnit } from "../../unit-enrichment.service.js";
import { UNIT_REPOSITORY, type UnitRepositoryPort } from "../../ports/unit-repository.port.js";
import { UpdateUnitCommand } from "./update-unit.command.js";

@CommandHandler(UpdateUnitCommand)
export class UpdateUnitHandler implements ICommandHandler<UpdateUnitCommand, EnrichedUnit> {
  constructor(
    private readonly clinicAccess: ClinicAccessChecker,
    private readonly technicalManagers: TechnicalManagerValidator,
    private readonly enrichment: UnitEnrichmentService,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: UpdateUnitCommand): Promise<EnrichedUnit> {
    const existing = await this.units.findById(command.unitId);
    if (!existing) throw new NotFoundError("Unit", command.unitId);

    // Whether this actor may act on the unit's *own* clinic -- the richer check
    // ClinicAccessChecker already applies to create/list, used here instead of a bare
    // `belongsToTenant` comparison because a unit's accessibility follows the same
    // home-tenant/membership/operator-link rules a clinic's does, not a single tenantId
    // equality (there is no cross-clinic reassignment to additionally validate -- see
    // UpdateUnitRequestSchema's own docstring on why `clinicTenantId` isn't editable).
    await this.clinicAccess.assertCanAccessClinic(existing.clinicTenantId, command.actor);

    if (command.changes.technicalManagerId) {
      await this.technicalManagers.assertEligible(command.changes.technicalManagerId, existing.clinicTenantId);
    }

    if (command.changes.name) {
      const collision = await this.units.findByClinicAndName(existing.clinicTenantId, command.changes.name);
      if (collision && collision.id !== existing.id) {
        throw new ConflictError(`A unit named "${command.changes.name}" already exists in this clinic`);
      }
    }

    const updated = await this.units.update(existing.id, command.changes);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: existing.clinicTenantId,
        userId: command.actor.userId,
        sessionId: null,
        action: AuditAction.UNIT_UPDATED,
        resourceType: "Unit",
        resourceId: existing.id,
        // Field *names* only -- same flat rule EQUIPMENT_UPDATED's own audit entry follows,
        // for the same reason: simpler to keep correct than judging each field as sensitive
        // or not, case by case, as new ones get added later.
        details: { changedFields: Object.keys(command.changes) },
      })
    );

    return this.enrichment.enrichOne(updated);
  }
}
