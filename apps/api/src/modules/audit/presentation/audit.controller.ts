import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { QueryBus } from "@nestjs/cqrs";
import { UserRole, type AccessTokenClaims } from "@crop/shared";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../iam/presentation/guards/roles.guard.js";
import { Roles } from "../../iam/presentation/decorators/roles.decorator.js";
import { CurrentUser } from "../../iam/presentation/decorators/current-user.decorator.js";
import { ListAuditLogsQuery } from "../application/queries/list-audit-logs/list-audit-logs.query.js";
import { VerifyAuditChainQuery } from "../application/queries/verify-audit-chain/verify-audit-chain.query.js";

@Controller("audit")
@UseGuards(JwtAuthGuard, RolesGuard)
// LOCAL_SUPERVISOR and OPERATOR_ADMIN added alongside the clinic/operator-provider role
// split (see packages/shared/src/roles.ts) -- a clinic's own local supervisor and an
// operator company's admin both need to be able to review the audit trail for their tenant,
// same reasoning as OPERATIONAL_SUPERVISOR (renamed from SUPERVISOR) already having it.
@Roles(
  UserRole.AUDITOR,
  UserRole.CLINIC_ADMIN,
  UserRole.PLATFORM_ADMIN,
  UserRole.OPERATIONAL_SUPERVISOR,
  UserRole.LOCAL_SUPERVISOR,
  UserRole.OPERATOR_ADMIN
)
export class AuditController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get()
  async list(
    @CurrentUser() user: AccessTokenClaims,
    @Query("sessionId") sessionId?: string,
    @Query("userId") userId?: string,
    @Query("limit") limit = "100",
    @Query("offset") offset = "0"
  ) {
    return this.queryBus.execute(
      new ListAuditLogsQuery(user.tenantId, sessionId, userId, Number(limit), Number(offset))
    );
  }

  @Get("verify")
  async verify(@CurrentUser() user: AccessTokenClaims) {
    return this.queryBus.execute(new VerifyAuditChainQuery(user.tenantId));
  }
}
