import { Body, Controller, Get, Inject, Post, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { CreatePlatformAdminRequestSchema, UserRole, type AccessTokenClaims, type CreatePlatformAdminRequest } from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "./guards/jwt-auth.guard.js";
import { RolesGuard } from "./guards/roles.guard.js";
import { Roles } from "./decorators/roles.decorator.js";
import { CurrentUser } from "./decorators/current-user.decorator.js";
import { ListUsersByTenantQuery } from "../application/queries/list-users-by-tenant/list-users-by-tenant.query.js";
import { User } from "../domain/user.entity.js";
import { RegisterUserCommand, type RegisterUserResult } from "../application/commands/register-user/register-user.command.js";
import { SendInvitationCommand } from "../application/commands/send-invitation/send-invitation.command.js";
import { USER_CLINIC_MEMBERSHIP_REPOSITORY, type UserClinicMembershipRepositoryPort } from "../application/ports/user-clinic-membership.port.js";
import { toUserDto } from "./user.dto.js";

/**
 * The platform's own administrators -- the only way to create a PLATFORM_ADMIN besides
 * bootstrap-superadmin.ts (which only ever creates the first). PLATFORM_ADMIN-only, and the
 * new account always lands in the caller's own PLATFORM tenant: there is no body field that
 * could point it anywhere else. Same invitation flow as `POST /users` -- the new admin picks
 * their own password from the link and enrolls MFA on first login.
 *
 * Lock, unlock and resend-invitation reuse UsersController's endpoints (a platform admin's
 * own tenant is the PLATFORM one, so they already apply). LockUserHandler is what keeps the
 * last active platform admin from being locked.
 */
@Controller("platform/admins")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformAdminsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @Inject(USER_CLINIC_MEMBERSHIP_REPOSITORY) private readonly memberships: UserClinicMembershipRepositoryPort
  ) {}

  @Get()
  async list(@CurrentUser() admin: AccessTokenClaims) {
    const users = await this.queryBus.execute<ListUsersByTenantQuery, User[]>(new ListUsersByTenantQuery(admin.tenantId));
    const admins = users.filter((u) => u.role === UserRole.PLATFORM_ADMIN);
    const clinicsByUser = await this.memberships.listClinicIdsForUsers(admins.map((u) => u.id));
    return admins.map((u) => toUserDto(u, clinicsByUser[u.id]));
  }

  @Post()
  async create(
    @CurrentUser() admin: AccessTokenClaims,
    @Body(new ZodValidationPipe(CreatePlatformAdminRequestSchema)) body: CreatePlatformAdminRequest
  ) {
    const result: RegisterUserResult = await this.commandBus.execute(
      new RegisterUserCommand(admin.tenantId, body.email, UserRole.PLATFORM_ADMIN, body.firstName, body.lastName, admin.sub, null, admin.role, [], true)
    );
    await this.commandBus.execute(new SendInvitationCommand(result.userId, admin.sub, null, false));
    return { userId: result.userId };
  }
}
