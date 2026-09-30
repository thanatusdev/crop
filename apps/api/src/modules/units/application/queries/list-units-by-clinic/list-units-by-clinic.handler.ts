import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { ClinicAccessChecker } from "../../clinic-access-checker.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { UnitEnrichmentService, type EnrichedUnit } from "../../unit-enrichment.service.js";
import { UNIT_REPOSITORY, type UnitRepositoryPort } from "../../ports/unit-repository.port.js";
import { ListUnitsByClinicQuery } from "./list-units-by-clinic.query.js";

@QueryHandler(ListUnitsByClinicQuery)
export class ListUnitsByClinicHandler implements IQueryHandler<ListUnitsByClinicQuery, EnrichedUnit[]> {
  constructor(
    private readonly clinicAccess: ClinicAccessChecker,
    private readonly operatorAccess: OperatorAccessService,
    private readonly enrichment: UnitEnrichmentService,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepositoryPort
  ) {}

  async execute(query: ListUnitsByClinicQuery): Promise<EnrichedUnit[]> {
    // Same actor-scope check as CreateUnitHandler: without this, any authenticated user
    // could pass an arbitrary `?clinicTenantId=` and browse a clinic they have nothing to
    // do with -- unlike EquipmentController's GET routes, which only ever act on the
    // caller's own `user.tenantId`, this one takes an independent query param.
    await this.clinicAccess.assertCanAccessClinic(
      query.clinicTenantId,
      query.requestingUserId && query.requestingTenantId && query.requestingRole
        ? { userId: query.requestingUserId, tenantId: query.requestingTenantId, role: query.requestingRole }
        : null
    );

    const units = await this.units.listByClinic(query.clinicTenantId);
    // Clinic-level access above is necessary but not sufficient: a contracted operator's
    // agreement may cover only some of this clinic's rooms. Narrowed here, not just at
    // `GET /equipment`, which is what closes a real gap -- see filterReachableUnits's own
    // docstring.
    const reachable = query.actor ? await this.operatorAccess.filterReachableUnits(query.actor, units) : units;
    return this.enrichment.enrichMany(reachable);
  }
}
