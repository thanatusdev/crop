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
import { USER_CLINIC_MEMBERSHIP_REPOSITORY } from "./application/ports/user-clinic-membership.port.js";
import { PASSWORD_HASHER } from "./application/ports/password-hasher.port.js";
import { MFA_SERVICE } from "./application/ports/mfa-service.port.js";
import { TOKEN_SERVICE } from "./application/ports/token-service.port.js";
import { RATE_LIMITER } from "./application/ports/rate-limiter.port.js";
import { TOKEN_REVOCATION } from "./application/ports/token-revocation.port.js";

import { PrismaUserRepository } from "./infrastructure/prisma-user.repository.js";
import { PrismaUserClinicMembershipRepository } from "./infrastructure/prisma-user-clinic-membership.repository.js";
import { Argon2PasswordHasher } from "./infrastructure/argon2-password-hasher.js";
import { OtpauthMfaService } from "./infrastructure/otpauth-mfa.service.js";
import { JwtTokenService } from "./infrastructure/jwt-token.service.js";
import { RedisRateLimiterService } from "./infrastructure/redis-rate-limiter.service.js";
import { RedisTokenRevocationService } from "./infrastructure/redis-token-revocation.service.js";

import { RegisterUserHandler } from "./application/commands/register-user/register-user.handler.js";
import { UpdateUserHandler } from "./application/commands/update-user/update-user.handler.js";
import { LoginHandler } from "./application/commands/login/login.handler.js";
import { VerifyMfaHandler } from "./application/commands/verify-mfa/verify-mfa.handler.js";
import { RefreshTokensHandler } from "./application/commands/refresh-tokens/refresh-tokens.handler.js";
import { LogoutHandler } from "./application/commands/logout/logout.handler.js";
import { LockUserHandler } from "./application/commands/lock-user/lock-user.handler.js";
import { UnlockUserHandler } from "./application/commands/unlock-user/unlock-user.handler.js";
import { AdminResetPasswordHandler } from "./application/commands/admin-reset-password/admin-reset-password.handler.js";
import { ConfirmMfaEnrollmentHandler } from "./application/commands/enroll-mfa/confirm-mfa-enrollment.handler.js";
import { RequestPasswordResetHandler } from "./application/commands/request-password-reset/request-password-reset.handler.js";
import { ResetPasswordHandler } from "./application/commands/reset-password/reset-password.handler.js";
import { ChangePasswordHandler } from "./application/commands/change-password/change-password.handler.js";
import { SendInvitationHandler } from "./application/commands/send-invitation/send-invitation.handler.js";
import { ActivateAccountHandler } from "./application/commands/activate-account/activate-account.handler.js";
import { SwitchActiveClinicHandler } from "./application/commands/switch-active-clinic/switch-active-clinic.handler.js";
import { GetUserByIdHandler } from "./application/queries/get-user-by-id/get-user-by-id.handler.js";
import { ListUsersByTenantHandler } from "./application/queries/list-users-by-tenant/list-users-by-tenant.handler.js";
import { ValidatePasswordResetTokenHandler } from "./application/queries/validate-password-reset-token/validate-password-reset-token.handler.js";
import { PreviewInvitationHandler } from "./application/queries/preview-invitation/preview-invitation.handler.js";
import { ListMyClinicsHandler } from "./application/queries/list-my-clinics/list-my-clinics.handler.js";
import { GetMeHandler } from "./application/queries/get-me/get-me.handler.js";
import { AuditModule } from "../audit/audit.module.js";
import { TenantsModule } from "../tenants/tenants.module.js";
import { MailModule } from "../../shared/infrastructure/mail/mail.module.js";
import { AccessModule } from "../access/access.module.js";

const COMMAND_AND_QUERY_HANDLERS = [
  RegisterUserHandler,
  UpdateUserHandler,
  LoginHandler,
  VerifyMfaHandler,
  RefreshTokensHandler,
  LogoutHandler,
  LockUserHandler,
  UnlockUserHandler,
  AdminResetPasswordHandler,
  ConfirmMfaEnrollmentHandler,
  RequestPasswordResetHandler,
  ResetPasswordHandler,
  ChangePasswordHandler,
  SendInvitationHandler,
  ActivateAccountHandler,
  SwitchActiveClinicHandler,
  GetUserByIdHandler,
  ListUsersByTenantHandler,
  ValidatePasswordResetTokenHandler,
  PreviewInvitationHandler,
  ListMyClinicsHandler,
  GetMeHandler,
];

@Module({
  imports: [
    CqrsModule,
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.register({}),
    AuditModule,
    // For LoginHandler/RefreshTokensHandler (tenant-deactivation status), RegisterUserHandler
    // (the role<->tenant-type invariant), and RequestPasswordResetHandler/ResetPasswordHandler
    // (same deactivation re-check, at request and at confirm time) via TENANT_REPOSITORY --
    // IamModule has no other relationship with tenant lifecycle.
    TenantsModule,
    // For RequestPasswordResetHandler's MAILER dependency -- see that handler's docstring.
    MailModule,
    // For SwitchActiveClinicHandler and ListMyClinicsHandler: a contracted operator's reachable
    // clinics come from ACTIVE `OperatorAgreement` rows, not from `UserClinicMembership`. This is
    // the edge that forced the agreement *read* side into its own `AccessModule` -- AgreementsModule
    // has a controller and therefore needs this module's guards, so it could not be imported here
    // without a cycle. See AccessModule's own docstring.
    AccessModule,
  ],
  controllers: [AuthController, UsersController],
  providers: [
    JwtAccessStrategy,
    JwtAuthGuard,
    RolesGuard,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: USER_CLINIC_MEMBERSHIP_REPOSITORY, useClass: PrismaUserClinicMembershipRepository },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: MFA_SERVICE, useClass: OtpauthMfaService },
    { provide: TOKEN_SERVICE, useClass: JwtTokenService },
    { provide: RATE_LIMITER, useClass: RedisRateLimiterService },
    { provide: TOKEN_REVOCATION, useClass: RedisTokenRevocationService },
    ...COMMAND_AND_QUERY_HANDLERS,
  ],
  exports: [JwtAuthGuard, RolesGuard, USER_REPOSITORY, USER_CLINIC_MEMBERSHIP_REPOSITORY, TOKEN_SERVICE],
})
export class IamModule {}
