import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  AdminResetPasswordRequestSchema,
  UserRole,
  type AccessTokenClaims,
  type AdminResetPasswordRequest,
} from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "./guards/jwt-auth.guard.js";
import { RolesGuard } from "./guards/roles.guard.js";
import { Roles } from "./decorators/roles.decorator.js";
import { CurrentUser } from "./decorators/current-user.decorator.js";
import { GetUserByIdQuery } from "../application/queries/get-user-by-id/get-user-by-id.query.js";
import { LockUserCommand } from "../application/commands/lock-user/lock-user.command.js";
import { UnlockUserCommand } from "../application/commands/unlock-user/unlock-user.command.js";
import { AdminResetPasswordCommand } from "../application/commands/admin-reset-password/admin-reset-password.command.js";
import { toUserDto } from "./user.dto.js";

/**
 * Administrative user management -- lock/unlock and forced password reset. Everything here
 * is CLINIC_ADMIN/PLATFORM_ADMIN-only and tenant-scoped the same way EquipmentController is
 * (each command's handler re-checks `belongsToTenant`, not trusted to this controller alone).
 * There is deliberately no `POST /users` (self-service or admin-driven creation): user
 * provisioning is an out-of-band operation via the seed script / RegisterUserCommand only --
 * see docs/architecture.md.
 */
@Controller("users")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PLATFORM_ADMIN, UserRole.CLINIC_ADMIN)
export class UsersController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus
  ) {}

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
