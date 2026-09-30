import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { UnitsController } from "./presentation/units.controller.js";
import { UNIT_REPOSITORY } from "./application/ports/unit-repository.port.js";
import { PrismaUnitRepository } from "./infrastructure/prisma-unit.repository.js";
import { ClinicAccessChecker } from "./application/clinic-access-checker.js";
import { TechnicalManagerValidator } from "./application/technical-manager-validator.js";
import { UnitEnrichmentService } from "./application/unit-enrichment.service.js";
import { TenantsModule } from "../tenants/tenants.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { IamModule } from "../iam/iam.module.js";
import { AccessModule } from "../access/access.module.js";

import { CreateUnitHandler } from "./application/commands/create-unit/create-unit.handler.js";
import { UpdateUnitHandler } from "./application/commands/update-unit/update-unit.handler.js";
import { SetUnitDeactivatedHandler } from "./application/commands/set-unit-deactivated/set-unit-deactivated.handler.js";
import { ListUnitsByClinicHandler } from "./application/queries/list-units-by-clinic/list-units-by-clinic.handler.js";
import { ListAccessibleUnitsHandler } from "./application/queries/list-accessible-units/list-accessible-units.handler.js";
import { GetUnitHandler } from "./application/queries/get-unit/get-unit.handler.js";
import { ListTechnicalManagerOptionsHandler } from "./application/queries/list-technical-manager-options/list-technical-manager-options.handler.js";

const COMMAND_AND_QUERY_HANDLERS = [
  CreateUnitHandler,
  UpdateUnitHandler,
  SetUnitDeactivatedHandler,
  ListUnitsByClinicHandler,
  ListAccessibleUnitsHandler,
  GetUnitHandler,
  ListTechnicalManagerOptionsHandler,
];

@Module({
  // AuditModule: RecordAuditEventCommand's handler, for UNIT_CREATED/UPDATED/DEACTIVATED/
  // REACTIVATED. IamModule: USER_CLINIC_MEMBERSHIP_REPOSITORY for ClinicAccessChecker's
  // membership check and ListAccessibleUnitsHandler's own; USER_REPOSITORY for
  // TechnicalManagerValidator and ListTechnicalManagerOptionsHandler. No cycle -- IamModule
  // has no dependency on UnitsModule. EquipmentModule imports UnitsModule (for
  // UNIT_REPOSITORY), the one-directional edge PrismaUnitRepository's equipment/room
  // aggregation deliberately does NOT reverse (see that repository's own docstring on why
  // it reaches into the `equipment` table directly instead).
  imports: [CqrsModule, TenantsModule, AuditModule, IamModule, AccessModule],
  controllers: [UnitsController],
  providers: [
    { provide: UNIT_REPOSITORY, useClass: PrismaUnitRepository },
    ClinicAccessChecker,
    TechnicalManagerValidator,
    UnitEnrichmentService,
    ...COMMAND_AND_QUERY_HANDLERS,
  ],
  exports: [UNIT_REPOSITORY, ClinicAccessChecker],
})
export class UnitsModule {}
