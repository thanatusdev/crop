import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
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
import { LockUserCommand } from "../application/commands/lock-user/lock-user.command.js";
import { UnlockUserCommand } from "../application/commands/unlock-user/unlock-user.command.js";
import { AdminResetPasswordCommand } from "../application/commands/admin-reset-password/admin-reset-password.command.js";
import { RegisterUserCommand, type RegisterUserResult } from "../application/commands/register-user/register-user.command.js";
import { toUserDto } from "./user.dto.js";

/**
 * Administrative user management -- lock/unlock, forced password reset, listing, and
 * creation. Everything here is CLINIC_ADMIN/PLATFORM_ADMIN-only and tenant-scoped the same
 * way EquipmentController is (each command's handler re-checks `belongsToTenant`, not
 * trusted to this controller alone). There is deliberately no *self-service* registration
 * endpoint (no mailer exists to send a new user their own credentials) -- `POST /users`
 * below is strictly an admin-driven action, and even then only for roles that make sense
 * scoped to one tenant; see CreateUserRequestSchema's own comment for why PLATFORM_ADMIN is
 * excluded.
 */
@Controller("users")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN)
export class UsersController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus
  ) {}

  @Get()
  async list(@CurrentUser() admin: AccessTokenClaims) {
    const users = await this.queryBus.execute(new ListUsersByTenantQuery(admin.tenantId));
    return users.map(toUserDto);
  }

  @Post()
  async create(@CurrentUser() admin: AccessTokenClaims, @Body(new ZodValidationPipe(CreateUserRequestSchema)) body: CreateUserRequest) {
    const result: RegisterUserResult = await this.commandBus.execute(
      new RegisterUserCommand(admin.tenantId, body.email, body.password, body.role)
    );
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
    return toUserDto(user);
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
}
