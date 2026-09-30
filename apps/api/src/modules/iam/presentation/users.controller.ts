import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  AdminResetPasswordRequestSchema,
  CreateUserRequestSchema,
  UserRole,
  type AccessTokenClaims,
  type AdminResetPasswordRequest,
  type CreateUserRequest,
} from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "./guards/jwt-auth.guard.js";
import { RolesGuard } from "./guards/roles.guard.js";
import { Roles } from "./decorators/roles.decorator.js";
import { CurrentUser } from "./decorators/current-user.decorator.js";
import { GetUserByIdQuery } from "../application/queries/get-user-by-id/get-user-by-id.query.js";
import { ListUsersByTenantQuery } from "../application/queries/list-users-by-tenant/list-users-by-tenant.query.js";
import { User } from "../domain/user.entity.js";
import { LockUserCommand } from "../application/commands/lock-user/lock-user.command.js";
import { UnlockUserCommand } from "../application/commands/unlock-user/unlock-user.command.js";
import { AdminResetPasswordCommand } from "../application/commands/admin-reset-password/admin-reset-password.command.js";
import { RegisterUserCommand, type RegisterUserResult } from "../application/commands/register-user/register-user.command.js";
import { SendInvitationCommand } from "../application/commands/send-invitation/send-invitation.command.js";
import { USER_CLINIC_MEMBERSHIP_REPOSITORY, type UserClinicMembershipRepositoryPort } from "../application/ports/user-clinic-membership.port.js";
import { toUserDto } from "./user.dto.js";

/**
 * Administrative user management -- lock/unlock, forced password reset, listing, and
 * creation. Everything here is tenant-scoped the same way EquipmentController is (each
 * command's handler re-checks `belongsToTenant`, not trusted to this controller alone).
 * CLINIC_ADMIN and OPERATOR_ADMIN are each the administrator of their own kind of tenant
 * (CLINIC and OPERATOR_PROVIDER respectively -- see packages/shared/src/roles.ts) and manage
 * only their own tenant's users; PLATFORM_ADMIN can act on any tenant.
 *
 * `LOCAL_SUPERVISOR` is here because the clinic-side rule is "the supervisor can do
 * everything except create other managers or supervisors". Note that the *class-level*
 * `@Roles` is only what gets a caller through the door -- which roles they may then hand out
 * is `canGrantRole`/`ROLE_GRANTS` (roles.ts), enforced in `RegisterUserHandler`, and that is
 * what actually stops a supervisor creating a peer or a manager. Widening `ROLE_GRANTS`
 * without adding the role here would have been inert: this gate rejects the request before
 * any grant check runs.
 *
 * `POST /users` no longer sets a password at all -- it creates the account and sends it a
 * secure, single-use, time-limited invitation link (see `SendInvitationCommand`). `POST
 * /users` is still the one exception to "tenant-scoped": a PLATFORM_ADMIN caller can target
 * any tenant via `body.tenantId` (the legacy single-tenant path, for roles this feature
 * doesn't touch) or any clinic via `body.clinicTenantIds` -- everyone else stays confined to
 * their own clinic(s) regardless of what they put in either field (`RegisterUserHandler`
 * enforces this, not this controller).
 */
@Controller("users")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.OPERATOR_ADMIN)
export class UsersController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @Inject(USER_CLINIC_MEMBERSHIP_REPOSITORY) private readonly memberships: UserClinicMembershipRepositoryPort
  ) {}

  @Get()
  async list(@CurrentUser() admin: AccessTokenClaims) {
    const users = await this.queryBus.execute<ListUsersByTenantQuery, User[]>(new ListUsersByTenantQuery(admin.tenantId));
    const clinicsByUser = await this.memberships.listClinicIdsForUsers(users.map((u) => u.id));
    return users.map((u) => toUserDto(u, clinicsByUser[u.id]));
  }

  @Post()
  async create(@CurrentUser() admin: AccessTokenClaims, @Body(new ZodValidationPipe(CreateUserRequestSchema)) body: CreateUserRequest) {
    // body.tenantId is honored only for PLATFORM_ADMIN -- bootstrapping a brand-new tenant's
    // first admin from outside it, or any other legacy single-tenant role. For everyone
    // else it's silently ignored, falling back to the caller's own tenant; see
    // CreateUserRequestSchema's own comment and the e2e test asserting this can't become a
    // privilege-escalation path for a CLINIC_ADMIN. `body.clinicTenantIds[0]` -- the new
    // account's home/active clinic -- takes priority for any caller (not just
    // PLATFORM_ADMIN): RegisterUserHandler is what actually enforces that every id in that
    // list is one the caller may use, so there's no privilege-escalation risk in reading it
    // here regardless of who's asking.
    const isPlatformAdmin = admin.role === UserRole.PLATFORM_ADMIN;
    const targetTenantId = body.clinicTenantIds?.[0]
      ? body.clinicTenantIds[0]
      : isPlatformAdmin && body.tenantId
        ? body.tenantId
        : admin.tenantId;
    const result: RegisterUserResult = await this.commandBus.execute(
      new RegisterUserCommand(
        targetTenantId,
        body.email,
        body.role,
        body.firstName,
        body.lastName,
        admin.sub,
        body.professionalRegistration ?? null,
        admin.role,
        body.clinicTenantIds ?? [],
        body.active
        // directActivation stays null: every HTTP-created account goes through the
        // invitation flow below, never an admin-typed password.
      )
    );

    // Composed here, not inside RegisterUserHandler: registration and "send the activation
    // email" are two separate concerns (mirrors infra/seeds/seed.ts composing
    // RegisterUserCommand + ConfirmMfaEnrollmentCommand as two dispatches, not one).
    await this.commandBus.execute(new SendInvitationCommand(result.userId, admin.sub, null, false));

    // Deliberately not the full RegisterUserResult (enrollmentToken/provisioningUri): those
    // are only meaningful to the new user's own first login (see LoginHandler), which
    // re-derives a fresh provisioningUri from the stored mfaSecret anyway. Handing them to
    // the *admin* here would let the admin also enroll as the new user, quietly undermining
    // the "two separate factors, two separate people" point of requiring MFA at all.
    return { userId: result.userId };
  }

  @Get(":id")
  async getOne(@CurrentUser() admin: AccessTokenClaims, @Param("id") id: string) {
    const user = await this.queryBus.execute(new GetUserByIdQuery(id, admin.tenantId));
    const clinicTenantIds = await this.memberships.listClinicIdsForUser(user.id);
    return toUserDto(user, clinicTenantIds);
  }

  @Post(":id/lock")
  @HttpCode(HttpStatus.NO_CONTENT)
  async lock(@CurrentUser() admin: AccessTokenClaims, @Param("id") id: string): Promise<void> {
    await this.commandBus.execute(new LockUserCommand(id, admin.sub, admin.tenantId));
  }

  @Post(":id/unlock")
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlock(@CurrentUser() admin: AccessTokenClaims, @Param("id") id: string): Promise<void> {
    await this.commandBus.execute(new UnlockUserCommand(id, admin.sub, admin.tenantId));
  }

  @Post(":id/reset-password")
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(
    @CurrentUser() admin: AccessTokenClaims,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(AdminResetPasswordRequestSchema)) body: AdminResetPasswordRequest
  ): Promise<void> {
    await this.commandBus.execute(new AdminResetPasswordCommand(id, body.newPassword, admin.sub, admin.tenantId));
  }

  // Re-sends the "Enviar Convite Seguro" link -- for a lost/expired email, or one an admin
  // wants to invalidate and re-issue. Only meaningful before the account is ever activated;
  // SendInvitationHandler itself rejects an already-activated target.
  @Post(":id/resend-invitation")
  @HttpCode(HttpStatus.NO_CONTENT)
  async resendInvitation(@CurrentUser() admin: AccessTokenClaims, @Param("id") id: string): Promise<void> {
    await this.commandBus.execute(new SendInvitationCommand(id, admin.sub, admin.tenantId, true));
  }
}
