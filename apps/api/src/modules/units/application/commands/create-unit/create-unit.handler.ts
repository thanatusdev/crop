import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ConflictError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { ClinicAccessChecker } from "../../clinic-access-checker.js";
import { TechnicalManagerValidator } from "../../technical-manager-validator.js";
import { UnitEnrichmentService, type EnrichedUnit } from "../../unit-enrichment.service.js";
import { UNIT_REPOSITORY, type UnitRepositoryPort } from "../../ports/unit-repository.port.js";
import { CreateUnitCommand } from "./create-unit.command.js";

@CommandHandler(CreateUnitCommand)
export class CreateUnitHandler implements ICommandHandler<CreateUnitCommand, EnrichedUnit> {
  constructor(
    private readonly clinicAccess: ClinicAccessChecker,
    private readonly technicalManagers: TechnicalManagerValidator,
    private readonly enrichment: UnitEnrichmentService,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: CreateUnitCommand): Promise<EnrichedUnit> {
    // Also validates the target is a real, active CLINIC tenant -- see
    // ClinicAccessChecker's own docstring for the full set of ways a caller may be linked,
    // and for why "active" is now actually enforced instead of just claimed here.
    await this.clinicAccess.assertCanAccessClinic(
      command.clinicTenantId,
      command.actingAdminId && command.actingAdminTenantId && command.actingRole
        ? { userId: command.actingAdminId, tenantId: command.actingAdminTenantId, role: command.actingRole }
        : null
    );

    await this.technicalManagers.assertEligible(command.unit.technicalManagerId, command.clinicTenantId);

    // Friendly pre-check before the insert -- see UnitRepositoryPort.findByClinicAndName's
    // own docstring for why (the same precedent RegisterUserHandler.findByEmail sets).
    const existing = await this.units.findByClinicAndName(command.clinicTenantId, command.unit.name);
    if (existing) {
      throw new ConflictError(`A unit named "${command.unit.name}" already exists in this clinic`);
    }

    const unit = await this.units.create({
      clinicTenantId: command.clinicTenantId,
      name: command.unit.name,
      establishmentType: command.unit.establishmentType,
      technicalManagerId: command.unit.technicalManagerId,
      declaredModalities: command.unit.declaredModalities,
      zipCode: command.unit.zipCode,
      street: command.unit.street,
      number: command.unit.number,
      complement: command.unit.complement,
      district: command.unit.district,
      city: command.unit.city,
      state: command.unit.state,
      cnesCode: command.unit.cnesCode,
      phone: command.unit.phone,
      technicalEmail: command.unit.technicalEmail,
    });

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.clinicTenantId,
        userId: command.actingAdminId,
        sessionId: null,
        action: AuditAction.UNIT_CREATED,
        resourceType: "Unit",
        resourceId: unit.id,
        details: {
          name: unit.name,
          establishmentType: unit.establishmentType,
          declaredModalities: unit.declaredModalities,
          technicalManagerId: unit.technicalManagerId,
        },
      })
    );

    return this.enrichment.enrichOne(unit);
  }
}
