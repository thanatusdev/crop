import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { ClinicAccessChecker } from "../../clinic-access-checker.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { UnitEnrichmentService, type EnrichedUnit } from "../../unit-enrichment.service.js";
import { UNIT_REPOSITORY, type UnitRepositoryPort } from "../../ports/unit-repository.port.js";
import { GetUnitQuery } from "./get-unit.query.js";

@QueryHandler(GetUnitQuery)
export class GetUnitHandler implements IQueryHandler<GetUnitQuery, EnrichedUnit> {
  constructor(
    private readonly clinicAccess: ClinicAccessChecker,
    private readonly operatorAccess: OperatorAccessService,
    private readonly enrichment: UnitEnrichmentService,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepositoryPort
  ) {}

  async execute(query: GetUnitQuery): Promise<EnrichedUnit> {
    const unit = await this.units.findById(query.unitId);
    if (!unit) throw new NotFoundError("Unit", query.unitId);

    // Same scoping every other units route applies -- a caller who can't act on this
    // unit's clinic can't view the unit either, matching ListUnitsByClinicHandler.
    await this.clinicAccess.assertCanAccessClinic(unit.clinicTenantId, {
      userId: query.requestingUserId,
      tenantId: query.requestingTenantId,
      role: query.requestingRole,
    });
    // Clinic-level access is not scope: a contracted operator naming a specific unit their
    // agreement doesn't cover gets a real refusal here, not a silent view -- see
    // OperatorAccessService.assertCanReachUnit's own docstring for why this is a throw and
    // the list route's own equivalent is a filter instead.
    if (query.actor) await this.operatorAccess.assertCanReachUnit(query.actor, unit);

    return this.enrichment.enrichOne(unit);
  }
}
