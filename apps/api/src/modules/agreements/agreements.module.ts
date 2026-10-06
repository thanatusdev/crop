import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { AgreementsController } from "./presentation/agreements.controller.js";
import { AccessModule } from "../access/access.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { EquipmentModule } from "../equipment/equipment.module.js";
import { IamModule } from "../iam/iam.module.js";
import { TenantsModule } from "../tenants/tenants.module.js";
import { UnitsModule } from "../units/units.module.js";

import { ProposeAgreementHandler } from "./application/commands/propose-agreement/propose-agreement.handler.js";
import { RespondToAgreementHandler } from "./application/commands/respond-to-agreement/respond-to-agreement.handler.js";
import { RevokeAgreementHandler } from "./application/commands/revoke-agreement/revoke-agreement.handler.js";
import { SetAgreementScopeHandler } from "./application/commands/set-agreement-scope/set-agreement-scope.handler.js";
import { ListAgreementsHandler } from "./application/queries/list-agreements/list-agreements.handler.js";
import { GetAgreementHandler } from "./application/queries/get-agreement/get-agreement.handler.js";
import { ListClinicOptionsHandler } from "./application/queries/list-clinic-options/list-clinic-options.handler.js";
import { ListOperatorOptionsHandler } from "./application/queries/list-operator-options/list-operator-options.handler.js";
import { ListScopeOptionsHandler } from "./application/queries/list-scope-options/list-scope-options.handler.js";

const COMMAND_AND_QUERY_HANDLERS = [
  ProposeAgreementHandler,
  RespondToAgreementHandler,
  RevokeAgreementHandler,
  SetAgreementScopeHandler,
  ListAgreementsHandler,
  GetAgreementHandler,
  ListClinicOptionsHandler,
  ListOperatorOptionsHandler,
  ListScopeOptionsHandler,
];

/**
 * The *write* half of the clinic<->operator contract, plus its HTTP surface. The read half
 * (repository + `OperatorAccessService`) lives in `AccessModule` -- see that module's docstring for
 * the cycle that split them: this module needs IamModule for its controller's guards, and IamModule
 * needs agreement reads for the active-clinic switch.
 *
 * AccessModule: AGREEMENT_REPOSITORY. TenantsModule: TENANT_REPOSITORY, for validating that a
 * proposal really is between one CLINIC and one OPERATOR_PROVIDER and that neither is deactivated.
 * AuditModule: the AGREEMENT_* rows. IamModule: JwtAuthGuard/RolesGuard. EquipmentModule/UnitsModule:
 * EQUIPMENT_REPOSITORY/UNIT_REPOSITORY, for `ListScopeOptionsHandler` -- the one place this module
 * reads a clinic's actual inventory rather than just its agreements. No cycle: neither module (nor
 * anything they import) imports `AgreementsModule` back -- only `AppModule` does.
 */
@Module({
  imports: [CqrsModule, AccessModule, TenantsModule, AuditModule, IamModule, EquipmentModule, UnitsModule],
  controllers: [AgreementsController],
  providers: [...COMMAND_AND_QUERY_HANDLERS],
})
export class AgreementsModule {}
