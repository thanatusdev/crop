import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { TenantType, UserRole } from "@crop/shared";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import {
  USER_CLINIC_MEMBERSHIP_REPOSITORY,
  type UserClinicMembershipRepositoryPort,
} from "../../../../iam/application/ports/user-clinic-membership.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { UnitEnrichmentService, type EnrichedUnit } from "../../unit-enrichment.service.js";
import { UNIT_REPOSITORY, type UnitRepositoryPort } from "../../ports/unit-repository.port.js";
import { ListAccessibleUnitsQuery } from "./list-accessible-units.query.js";

/**
 * The "Todas as Clínicas" option on the units listing screen's clinic filter -- the one
 * place this feature looks across more than one clinic at once, since every other route
 * here (`GET /units?clinicTenantId=`, `POST /units`, ...) is deliberately scoped to exactly
 * one. Reuses the same "which clinics can this actor reach" logic
 * `ListMyClinicsHandler`/`ClinicAccessChecker` each already have their own version of --
 * `PLATFORM_ADMIN` reaches every `CLINIC` tenant; anyone else reaches their own home
 * tenant, every clinic they hold a `UserClinicMembership` row for, and any clinic whose
 * `operatorTenantId` is their own home tenant (the same three cases
 * `ClinicAccessChecker.assertCanAccessClinic` already allows, computed here as a *set*
 * instead of checked one id at a time).
 */
@QueryHandler(ListAccessibleUnitsQuery)
export class ListAccessibleUnitsHandler implements IQueryHandler<ListAccessibleUnitsQuery, EnrichedUnit[]> {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(USER_CLINIC_MEMBERSHIP_REPOSITORY) private readonly memberships: UserClinicMembershipRepositoryPort,
    private readonly enrichment: UnitEnrichmentService,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepositoryPort,
    private readonly operatorAccess: OperatorAccessService
  ) {}

  async execute(query: ListAccessibleUnitsQuery): Promise<EnrichedUnit[]> {
    const clinics = (await this.tenants.listAll()).filter((tenant) => tenant.type === TenantType.CLINIC);

    let accessibleClinicIds: string[];
    if (query.requestingRole === UserRole.PLATFORM_ADMIN) {
      accessibleClinicIds = clinics.map((clinic) => clinic.id);
    } else {
      const membershipIds = new Set(await this.memberships.listClinicIdsForUser(query.requestingUserId));
      // Replaced a `clinic.operatorTenantId === requestingTenantId` comparison: an operating
      // company may now hold live contracts with any number of clinics, and only ACTIVE ones
      // count.
      const contractedIds = new Set(await this.operatorAccess.listAccessibleClinicIdsForOperator(query.requestingTenantId));
      accessibleClinicIds = clinics
        .filter((clinic) => clinic.id === query.requestingTenantId || membershipIds.has(clinic.id) || contractedIds.has(clinic.id))
        .map((clinic) => clinic.id);
    }

    const units = await this.units.listByClinics(accessibleClinicIds);
    const reachable = query.actor ? await this.operatorAccess.filterReachableUnits(query.actor, units) : units;
    return this.enrichment.enrichMany(reachable);
  }
}
