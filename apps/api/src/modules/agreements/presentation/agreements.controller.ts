import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  AgreementStatus,
  ProposeAgreementRequestSchema,
  SetAgreementScopeRequestSchema,
  UserRole,
  type AccessTokenClaims,
  type ClinicAgreementOption,
  type OperatorAgreementDto,
  type ProposeAgreementRequest,
  type SetAgreementScopeRequest,
} from "@crop/shared";
import { ValidationError } from "../../../shared/domain/errors.js";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../iam/presentation/guards/roles.guard.js";
import { Roles } from "../../iam/presentation/decorators/roles.decorator.js";
import { CurrentUser } from "../../iam/presentation/decorators/current-user.decorator.js";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../access/application/ports/agreement-repository.port.js";
import { OperatorAgreement } from "../../access/domain/operator-agreement.entity.js";
import { ProposeAgreementCommand } from "../application/commands/propose-agreement/propose-agreement.command.js";
import { RespondToAgreementCommand } from "../application/commands/respond-to-agreement/respond-to-agreement.command.js";
import { RevokeAgreementCommand } from "../application/commands/revoke-agreement/revoke-agreement.command.js";
import { SetAgreementScopeCommand } from "../application/commands/set-agreement-scope/set-agreement-scope.command.js";
import { GetAgreementQuery } from "../application/queries/get-agreement/get-agreement.query.js";
import { ListAgreementsQuery } from "../application/queries/list-agreements/list-agreements.query.js";
import { ListClinicOptionsQuery } from "../application/queries/list-clinic-options/list-clinic-options.query.js";
import { toAgreementDto, toAgreementDtos } from "./agreement.dto.js";

/**
 * The clinic<->operating-company contract surface.
 *
 * `@Roles` is the administrator of each side plus `PLATFORM_ADMIN`: `CLINIC_ADMIN` and
 * `LOCAL_SUPERVISOR` for the clinic ("the supervisor can do everything except create managers"),
 * `OPERATOR_ADMIN` for the company (rule: the operator admin accepts and sends contracts).
 * Deliberately *not* `OPERATOR` or `OPERATIONAL_SUPERVISOR` -- an individual operator running exams
 * has no business widening or ending their employer's commercial relationships, and
 * `OPERATIONAL_SUPERVISOR` supervises sessions, not contracts.
 *
 * Every route is additionally scoped inside its handler to agreements the caller's tenant is party
 * to, so the role gate is a coarse filter rather than the real boundary -- the same split the rest
 * of this codebase uses.
 *
 * Note `tenantId` throughout is the caller's **home** tenant, not their active one: a clinic admin
 * has only one, but an operator admin may be switched into a client clinic's context while managing
 * their own company's contracts, and reading `claims.tenantId` there would silently scope the whole
 * screen to the wrong organisation.
 */
@Controller("agreements")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.OPERATOR_ADMIN)
export class AgreementsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort
  ) {}

  private homeTenantOf(user: AccessTokenClaims): string {
    return user.homeTenantId ?? user.tenantId;
  }

  @Get()
  async list(@CurrentUser() user: AccessTokenClaims, @Query("status") status?: string): Promise<OperatorAgreementDto[]> {
    // Validated rather than passed through: an unrecognised status would otherwise reach Prisma as a
    // bogus enum value and surface as a 500 instead of a 400.
    if (status && !(Object.values(AgreementStatus) as string[]).includes(status)) {
      throw new ValidationError(`Unknown agreement status: ${status}`);
    }
    const agreements: OperatorAgreement[] = await this.queryBus.execute(
      new ListAgreementsQuery(this.homeTenantOf(user), status as AgreementStatus | undefined)
    );
    return toAgreementDtos(agreements, this.agreements);
  }

  /** Declared before `:id` -- a static route after a param route of the same shape would never be
   * reached, since Nest matches in declaration order and "clinic-options" would just bind to `:id`.
   * `OPERATOR_ADMIN`-only, narrower than the class-level `@Roles`: this is the operator-side
   * "Propor Contrato" picker's own data source -- see `ClinicAgreementOptionSchema`'s own docstring
   * in packages/shared for why it exists instead of pointing that picker at `GET /tenants`. */
  @Get("clinic-options")
  @Roles(UserRole.OPERATOR_ADMIN)
  async listClinicOptions(@CurrentUser() user: AccessTokenClaims): Promise<ClinicAgreementOption[]> {
    return this.queryBus.execute(new ListClinicOptionsQuery(this.homeTenantOf(user)));
  }

  @Get(":id")
  async getOne(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string): Promise<OperatorAgreementDto> {
    const agreement: OperatorAgreement = await this.queryBus.execute(new GetAgreementQuery(id, this.homeTenantOf(user)));
    return this.toDto(agreement);
  }

  @Post()
  async propose(
    @CurrentUser() user: AccessTokenClaims,
    @Body(new ZodValidationPipe(ProposeAgreementRequestSchema)) body: ProposeAgreementRequest
  ): Promise<OperatorAgreementDto> {
    // The schema guarantees exactly one of the two is present; whichever it is, it names the
    // *counterparty*. The handler decides which side is which from the tenant types, so a caller
    // cannot misrepresent their own side by choosing the "wrong" field.
    const counterparty = body.clinicTenantId ?? body.operatorTenantId!;
    const agreement: OperatorAgreement = await this.commandBus.execute(
      new ProposeAgreementCommand(user, counterparty, body.unitIds ?? [], body.equipmentIds ?? [])
    );
    return this.toDto(agreement);
  }

  @Post(":id/accept")
  async accept(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string): Promise<OperatorAgreementDto> {
    const agreement: OperatorAgreement = await this.commandBus.execute(new RespondToAgreementCommand(user, id, true));
    return this.toDto(agreement);
  }

  @Post(":id/reject")
  async reject(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string): Promise<OperatorAgreementDto> {
    const agreement: OperatorAgreement = await this.commandBus.execute(new RespondToAgreementCommand(user, id, false));
    return this.toDto(agreement);
  }

  @Post(":id/revoke")
  @HttpCode(HttpStatus.OK)
  async revoke(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string): Promise<OperatorAgreementDto> {
    const agreement: OperatorAgreement = await this.commandBus.execute(new RevokeAgreementCommand(user, id));
    return this.toDto(agreement);
  }

  /** `PUT`, not `PATCH`: this replaces the whole scope set rather than merging into it -- see
   * `SetAgreementScopeRequestSchema`. */
  @Put(":id/scope")
  async setScope(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetAgreementScopeRequestSchema)) body: SetAgreementScopeRequest
  ): Promise<OperatorAgreementDto> {
    const agreement: OperatorAgreement = await this.commandBus.execute(
      new SetAgreementScopeCommand(user, id, body.unitIds, body.equipmentIds)
    );
    return this.toDto(agreement);
  }

  private async toDto(agreement: OperatorAgreement): Promise<OperatorAgreementDto> {
    const names = await this.agreements.tenantNames([agreement.clinicTenantId, agreement.operatorTenantId]);
    return toAgreementDto(agreement, names, await this.agreements.resolveScopeTargets(agreement.id));
  }
}
