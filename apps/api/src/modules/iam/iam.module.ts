import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import { AuthController } from "./presentation/auth.controller.js";
import { UsersController } from "./presentation/users.controller.js";
import { JwtAccessStrategy } from "./presentation/strategies/jwt-access.strategy.js";
import { JwtAuthGuard } from "./presentation/guards/jwt-auth.guard.js";
import { RolesGuard } from "./presentation/guards/roles.guard.js";

import { USER_REPOSITORY } from "./application/ports/user-repository.port.js";
import { PASSWORD_HASHER } from "./application/ports/password-hasher.port.js";
import { MFA_SERVICE } from "./application/ports/mfa-service.port.js";
import { TOKEN_SERVICE } from "./application/ports/token-service.port.js";
import { RATE_LIMITER } from "./application/ports/rate-limiter.port.js";
import { TOKEN_REVOCATION } from "./application/ports/token-revocation.port.js";

import { PrismaUserRepository } from "./infrastructure/prisma-user.repository.js";
import { Argon2PasswordHasher } from "./infrastructure/argon2-password-hasher.js";
import { OtpauthMfaService } from "./infrastructure/otpauth-mfa.service.js";
import { JwtTokenService } from "./infrastructure/jwt-token.service.js";
import { RedisRateLimiterService } from "./infrastructure/redis-rate-limiter.service.js";
import { RedisTokenRevocationService } from "./infrastructure/redis-token-revocation.service.js";

import { RegisterUserHandler } from "./application/commands/register-user/register-user.handler.js";
import { LoginHandler } from "./application/commands/login/login.handler.js";
import { VerifyMfaHandler } from "./application/commands/verify-mfa/verify-mfa.handler.js";
import { RefreshTokensHandler } from "./application/commands/refresh-tokens/refresh-tokens.handler.js";
import { LogoutHandler } from "./application/commands/logout/logout.handler.js";
import { LockUserHandler } from "./application/commands/lock-user/lock-user.handler.js";
import { UnlockUserHandler } from "./application/commands/unlock-user/unlock-user.handler.js";
import { AdminResetPasswordHandler } from "./application/commands/admin-reset-password/admin-reset-password.handler.js";
import { ConfirmMfaEnrollmentHandler } from "./application/commands/enroll-mfa/confirm-mfa-enrollment.handler.js";
import { GetUserByIdHandler } from "./application/queries/get-user-by-id/get-user-by-id.handler.js";
import { AuditModule } from "../audit/audit.module.js";

const COMMAND_AND_QUERY_HANDLERS = [
  RegisterUserHandler,
  LoginHandler,
  VerifyMfaHandler,
  RefreshTokensHandler,
  LogoutHandler,
  LockUserHandler,
  UnlockUserHandler,
  AdminResetPasswordHandler,
  ConfirmMfaEnrollmentHandler,
  GetUserByIdHandler,
];

@Module({
  imports: [CqrsModule, PassportModule.register({ defaultStrategy: "jwt" }), JwtModule.register({}), AuditModule],
  controllers: [AuthController, UsersController],
  providers: [
    JwtAccessStrategy,
    JwtAuthGuard,
    RolesGuard,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: MFA_SERVICE, useClass: OtpauthMfaService },
    { provide: TOKEN_SERVICE, useClass: JwtTokenService },
    { provide: RATE_LIMITER, useClass: RedisRateLimiterService },
    { provide: TOKEN_REVOCATION, useClass: RedisTokenRevocationService },
    ...COMMAND_AND_QUERY_HANDLERS,
  ],
  exports: [JwtAuthGuard, RolesGuard, USER_REPOSITORY, TOKEN_SERVICE],
})
export class IamModule {}
