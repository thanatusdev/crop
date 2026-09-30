import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import type { ResponsibleManagerOption } from "@crop/shared";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../ports/tenant-repository.port.js";
import { ListResponsibleManagerOptionsQuery } from "./list-responsible-manager-options.query.js";

/**
 * Who the clinic edit form's "Gestor Responsável" picker offers: this clinic's own
 * activated, unlocked `CLINIC_ADMIN` users. No `ClinicAccessChecker`-style scoping needed --
 * `TenantsController` is `PLATFORM_ADMIN`-only for every route, with no caller's-own-tenant
 * concept to check against (see that controller's own docstring).
 */
@QueryHandler(ListResponsibleManagerOptionsQuery)
export class ListResponsibleManagerOptionsHandler implements IQueryHandler<ListResponsibleManagerOptionsQuery, ResponsibleManagerOption[]> {
  constructor(@Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort) {}

  async execute(query: ListResponsibleManagerOptionsQuery): Promise<ResponsibleManagerOption[]> {
    return this.tenants.listResponsibleManagerOptions(query.clinicTenantId);
  }
}
