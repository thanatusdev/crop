import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { AgreementStatus, TenantType, type AgreementCounterpartyOption } from "@crop/shared";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../../../access/application/ports/agreement-repository.port.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import { ListOperatorOptionsQuery } from "./list-operator-options.query.js";

/**
 * Every `OPERATOR_PROVIDER` tenant the caller's own clinic could still propose a contract to --
 * not deactivated, and not already `PENDING`/`ACTIVE` with this clinic (proposing again would
 * just hit `ProposeAgreementHandler`'s own `ConflictError`; excluding them here means the picker
 * never offers a choice that is guaranteed to fail).
 *
 * Exact mirror of `ListClinicOptionsHandler` with the tenant-type filter inverted -- see that
 * handler's own docstring for the reasoning, which applies here unchanged.
 */
@QueryHandler(ListOperatorOptionsQuery)
export class ListOperatorOptionsHandler implements IQueryHandler<ListOperatorOptionsQuery, AgreementCounterpartyOption[]> {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort
  ) {}

  async execute(query: ListOperatorOptionsQuery): Promise<AgreementCounterpartyOption[]> {
    const [allTenants, ownAgreements] = await Promise.all([this.tenants.listAll(), this.agreements.listForTenant(query.clinicTenantId)]);

    const unavailableOperatorIds = new Set(
      ownAgreements.filter((a) => a.status === AgreementStatus.PENDING || a.status === AgreementStatus.ACTIVE).map((a) => a.operatorTenantId)
    );

    return allTenants
      .filter((tenant) => tenant.type === TenantType.OPERATOR_PROVIDER && !tenant.isDeactivated() && !unavailableOperatorIds.has(tenant.id))
      .map((tenant) => ({ id: tenant.id, name: tenant.name }));
  }
}
