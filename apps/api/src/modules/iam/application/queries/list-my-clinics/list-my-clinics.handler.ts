import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { TenantType } from "@crop/shared";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import { USER_CLINIC_MEMBERSHIP_REPOSITORY, type UserClinicMembershipRepositoryPort } from "../../ports/user-clinic-membership.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { ListMyClinicsQuery } from "./list-my-clinics.query.js";

export interface MyClinicSummary {
  id: string;
  name: string;
  deactivated: boolean;
  active: boolean;
}

/**
 * Backs the clinic switcher (`GET /auth/me/clinics`): every clinic the caller can reach, with
 * `active` marking which one the caller's *current* access token is scoped to.
 *
 * "Can reach" has to agree with `SwitchActiveClinicHandler` -- this endpoint exists to
 * populate a picker whose every entry must actually be switchable -- so it accepts the same
 * two links that handler does: a `UserClinicMembership` row, or a clinic naming the caller's
 * home tenant as its operator.
 *
 * Two bugs fixed here, both surfaced (not caused) by the role-model inversion:
 *
 *  1. **Operator-linked clinics were missing.** `AdminUnitsPage`'s own docstring already
 *     documented this as "a pre-existing gap this page inherits rather than fixes": an
 *     OPERATOR_ADMIN whose only access came through the operator link saw units for a clinic
 *     that never appeared in their own clinic list, so the page fell back to rendering a raw
 *     tenant id where a name belonged. `ListAccessibleUnitsHandler` already accounted for the
 *     link; this handler never did.
 *  2. **The home tenant was added unconditionally, without checking it is a clinic.** Latent
 *     while every caller's home tenant was a CLINIC, and load-bearing now that operator-side
 *     accounts live in OPERATOR_PROVIDER tenants: an operator would otherwise have seen their
 *     own employer listed as a clinic they could switch into, which
 *     `SwitchActiveClinicHandler` would then correctly refuse ("Target is not a clinic") --
 *     a picker entry guaranteed to fail.
 */
@QueryHandler(ListMyClinicsQuery)
export class ListMyClinicsHandler implements IQueryHandler<ListMyClinicsQuery, MyClinicSummary[]> {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(USER_CLINIC_MEMBERSHIP_REPOSITORY) private readonly memberships: UserClinicMembershipRepositoryPort,
    private readonly operatorAccess: OperatorAccessService
  ) {}

  async execute(query: ListMyClinicsQuery): Promise<MyClinicSummary[]> {
    const membershipIds = new Set(await this.memberships.listClinicIdsForUser(query.userId));
    // Clinics reachable because the caller's own organisation is contracted to operate them.
    // Replaced a `tenant.operatorTenantId === homeTenantId` comparison, which could only ever
    // find one operating company per clinic; an operator may now hold live contracts with any
    // number of clinics, and only ACTIVE ones count.
    const contractedIds = new Set(await this.operatorAccess.listAccessibleClinicIdsForOperator(query.homeTenantId));

    // One pass over the tenant list covers both links and the "is it actually a clinic"
    // filter -- the same shape `ListAccessibleUnitsHandler` already uses to answer the same
    // question, rather than a second per-id `findById` loop.
    return (await this.tenants.listAll())
      .filter(
        (tenant) =>
          tenant.type === TenantType.CLINIC &&
          (tenant.id === query.homeTenantId || membershipIds.has(tenant.id) || contractedIds.has(tenant.id))
      )
      .map((tenant) => ({
        id: tenant.id,
        name: tenant.name,
        deactivated: tenant.isDeactivated(),
        active: tenant.id === query.activeTenantId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
