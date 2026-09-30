import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../../../access/application/ports/agreement-repository.port.js";
import { OperatorAgreement } from "../../../../access/domain/operator-agreement.entity.js";
import { GetAgreementQuery } from "./get-agreement.query.js";

@QueryHandler(GetAgreementQuery)
export class GetAgreementHandler implements IQueryHandler<GetAgreementQuery, OperatorAgreement> {
  constructor(@Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort) {}

  async execute(query: GetAgreementQuery): Promise<OperatorAgreement> {
    const agreement = await this.agreements.findById(query.agreementId);
    if (!agreement) throw new NotFoundError("OperatorAgreement", query.agreementId);
    // Load-then-check, the same shape GetEquipmentHandler/GetSessionHandler use: a tenant can never
    // read a contract it is not a party to by guessing its UUID.
    if (!agreement.involves(query.tenantId)) {
      throw new ForbiddenError("You are not a party to this agreement");
    }
    return agreement;
  }
}
