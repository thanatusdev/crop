import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { responsibleManagerRoleFor, type ResponsibleManagerOption } from "@crop/shared";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../ports/tenant-repository.port.js";
import { ListResponsibleManagerOptionsQuery } from "./list-responsible-manager-options.query.js";

/**
 * Who the clinic/operadora edit form's "Gestor Responsável" picker offers: that tenant's own
 * activated, unlocked `CLINIC_ADMIN`s (for a CLINIC) or `OPERATOR_ADMIN`s (for an
 * OPERATOR_PROVIDER) -- see `responsibleManagerRoleFor`. No `ClinicAccessChecker`-style
 * scoping needed -- `TenantsController` is `PLATFORM_ADMIN`-only for every route, with no
 * caller's-own-tenant concept to check against (see that controller's own docstring).
 */
@QueryHandler(ListResponsibleManagerOptionsQuery)
export class ListResponsibleManagerOptionsHandler implements IQueryHandler<ListResponsibleManagerOptionsQuery, ResponsibleManagerOption[]> {
  constructor(@Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort) {}

  async execute(query: ListResponsibleManagerOptionsQuery): Promise<ResponsibleManagerOption[]> {
    const tenant = await this.tenants.findById(query.tenantId);
    if (!tenant) throw new NotFoundError("Tenant", query.tenantId);
    const role = responsibleManagerRoleFor(tenant.type);
    if (!role) return [];
    return this.tenants.listResponsibleManagerOptions(query.tenantId, role);
  }
}
