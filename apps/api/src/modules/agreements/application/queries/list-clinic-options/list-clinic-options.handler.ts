import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { AgreementStatus, TenantType, type ClinicAgreementOption } from "@crop/shared";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../../../access/application/ports/agreement-repository.port.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import { ListClinicOptionsQuery } from "./list-clinic-options.query.js";

/**
 * Every `CLINIC` tenant the caller's own operating company could still propose a contract to --
 * not deactivated, and not already `PENDING`/`ACTIVE` with this company (proposing again would
 * just hit `ProposeAgreementHandler`'s own `ConflictError`; excluding them here means the picker
 * never offers a choice that is guaranteed to fail).
 *
 * `agreements.listForTenant` returns every agreement either side of which is the operator's own
 * tenant -- one query, filtered in memory, rather than `AgreementRepositoryPort` growing a second,
 * narrower "agreements by clinic-exclusion" method for this one caller.
 */
@QueryHandler(ListClinicOptionsQuery)
export class ListClinicOptionsHandler implements IQueryHandler<ListClinicOptionsQuery, ClinicAgreementOption[]> {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort
  ) {}

  async execute(query: ListClinicOptionsQuery): Promise<ClinicAgreementOption[]> {
    const [allTenants, ownAgreements] = await Promise.all([this.tenants.listAll(), this.agreements.listForTenant(query.operatorTenantId)]);

    const unavailableClinicIds = new Set(
      ownAgreements.filter((a) => a.status === AgreementStatus.PENDING || a.status === AgreementStatus.ACTIVE).map((a) => a.clinicTenantId)
    );

    return allTenants
      .filter((tenant) => tenant.type === TenantType.CLINIC && !tenant.isDeactivated() && !unavailableClinicIds.has(tenant.id))
      .map((tenant) => ({ id: tenant.id, name: tenant.name }));
  }
}
