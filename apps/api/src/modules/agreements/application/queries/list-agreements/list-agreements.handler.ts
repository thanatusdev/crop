import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../../../access/application/ports/agreement-repository.port.js";
import { OperatorAgreement } from "../../../../access/domain/operator-agreement.entity.js";
import { ListAgreementsQuery } from "./list-agreements.query.js";

/**
 * Every agreement the caller's tenant is party to, from either side -- the same query answers "our
 * operating companies" for a clinic and "our client clinics" for a company, because it is the same
 * question asked from two directions.
 *
 * No `@Roles`-style filtering here: the repository restricts to rows naming this tenant, so there is
 * nothing to leak. A caller simply cannot see a contract between two other organisations.
 */
@QueryHandler(ListAgreementsQuery)
export class ListAgreementsHandler implements IQueryHandler<ListAgreementsQuery, OperatorAgreement[]> {
  constructor(@Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort) {}

  async execute(query: ListAgreementsQuery): Promise<OperatorAgreement[]> {
    return this.agreements.listForTenant(query.tenantId, query.status);
  }
}
