import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { AgreementsController } from "./presentation/agreements.controller.js";
import { AccessModule } from "../access/access.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { IamModule } from "../iam/iam.module.js";
import { TenantsModule } from "../tenants/tenants.module.js";

import { ProposeAgreementHandler } from "./application/commands/propose-agreement/propose-agreement.handler.js";
import { RespondToAgreementHandler } from "./application/commands/respond-to-agreement/respond-to-agreement.handler.js";
import { RevokeAgreementHandler } from "./application/commands/revoke-agreement/revoke-agreement.handler.js";
import { SetAgreementScopeHandler } from "./application/commands/set-agreement-scope/set-agreement-scope.handler.js";
import { ListAgreementsHandler } from "./application/queries/list-agreements/list-agreements.handler.js";
import { GetAgreementHandler } from "./application/queries/get-agreement/get-agreement.handler.js";

const COMMAND_AND_QUERY_HANDLERS = [
  ProposeAgreementHandler,
  RespondToAgreementHandler,
  RevokeAgreementHandler,
  SetAgreementScopeHandler,
  ListAgreementsHandler,
  GetAgreementHandler,
];

/**
 * The *write* half of the clinic<->operator contract, plus its HTTP surface. The read half
 * (repository + `OperatorAccessService`) lives in `AccessModule` -- see that module's docstring for
 * the cycle that split them: this module needs IamModule for its controller's guards, and IamModule
 * needs agreement reads for the active-clinic switch.
 *
 * AccessModule: AGREEMENT_REPOSITORY. TenantsModule: TENANT_REPOSITORY, for validating that a
 * proposal really is between one CLINIC and one OPERATOR_PROVIDER and that neither is deactivated.
 * AuditModule: the AGREEMENT_* rows. IamModule: JwtAuthGuard/RolesGuard.
 */
@Module({
  imports: [CqrsModule, AccessModule, TenantsModule, AuditModule, IamModule],
  controllers: [AgreementsController],
  providers: [...COMMAND_AND_QUERY_HANDLERS],
})
export class AgreementsModule {}
