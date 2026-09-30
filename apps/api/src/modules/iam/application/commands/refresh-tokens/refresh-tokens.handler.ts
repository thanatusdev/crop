import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../../../../../shared/domain/errors.js";
import { TOKEN_REVOCATION, type TokenRevocationPort } from "../../ports/token-revocation.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { USER_CLINIC_MEMBERSHIP_REPOSITORY, type UserClinicMembershipRepositoryPort } from "../../ports/user-clinic-membership.port.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import { RefreshTokensCommand, type RefreshTokensResult } from "./refresh-tokens.command.js";

@CommandHandler(RefreshTokensCommand)
export class RefreshTokensHandler implements ICommandHandler<RefreshTokensCommand, RefreshTokensResult> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(USER_CLINIC_MEMBERSHIP_REPOSITORY) private readonly memberships: UserClinicMembershipRepositoryPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(TOKEN_REVOCATION) private readonly revocation: TokenRevocationPort
  ) {}

  async execute(command: RefreshTokensCommand): Promise<RefreshTokensResult> {
    const claims = this.tokens.verifyRefreshToken(command.refreshToken);

    if (await this.revocation.isRevoked(claims.jti)) {
      throw new UnauthorizedError("Refresh token has been revoked");
    }

    // Re-read the user rather than trusting the token's role claim: a role change or
    // deactivation must take effect immediately, not after the old access token expires.
    const user = await this.users.findById(claims.sub);
    if (!user) throw new NotFoundError("User", claims.sub);

    // This is the earliest point a lock imposed *after* the access token was issued
    // actually takes effect (access tokens carry no lock state of their own -- see
    // LockUserHandler's docstring on the bounded-window tradeoff this implies).
    if (user.isLocked()) {
      throw new ForbiddenError("This account has been locked. Contact your administrator.");
    }

    // `claims.tenantId` is this refresh token's own *active clinic* (see
    // SwitchActiveClinicHandler), which may differ from `user.tenantId` (the home tenant)
    // for a multi-clinic account -- re-validated as a real, still-current membership on
    // every refresh, not just at the moment `active-clinic` was called. Without this, an
    // admin revoking a Manager's access to a clinic wouldn't take effect for that
    // Manager's already-issued refresh tokens until they individually expired.
    const isStillMember = claims.tenantId === user.tenantId || (await this.memberships.isMember(user.id, claims.tenantId));
    if (!isStillMember) {
      throw new ForbiddenError("You are no longer linked to that clinic. Please switch clinics or log in again.");
    }

    const tenant = await this.tenants.findById(claims.tenantId);
    if (tenant?.isDeactivated()) {
      throw new ForbiddenError("This organization's access has been deactivated. Contact your administrator.");
    }

    // A self-service password reset (ResetPasswordHandler) revokes every session as of the
    // moment it completes -- but a refresh token isn't individually denylisted by jti for
    // this, since there could be several outstanding across devices/browsers. Comparing
    // this token's own `iat` against `sessionsRevokedAt` catches all of them at once, the
    // same bounded-window shape as the lock/deactivation checks above.
    if (user.issuedBeforeSessionsRevoked(claims.iat)) {
      throw new UnauthorizedError("Refresh token has been revoked");
    }

    const accessToken = this.tokens.signAccessToken({
      sub: user.id,
      tenantId: claims.tenantId,
      role: user.role,
      clientOs: claims.clientOs,
      // `claims.tenantId` is the tenant the caller was *acting in* (possibly a clinic they
      // switched into), while `user.tenantId` is always the tenant they belong to -- so a refresh
      // preserves a cross-tenant session rather than silently dropping the caller back into their
      // own tenant.
      //
      // Deliberately NOT re-validating the agreement here: revocation is enforced on every path
      // that actually touches the clinic's data (ClinicAccessChecker, and
      // OperatorAccessService on all equipment reads), so a revoked operator holding a
      // still-valid clinic-scoped token can reach nothing. Re-checking would add a query to a hot
      // path to close a gap that is already closed downstream.
      homeTenantId: user.tenantId,
    });
    const refreshToken = this.tokens.signRefreshToken({
      sub: user.id,
      tenantId: claims.tenantId,
      clientOs: claims.clientOs,
    });

    // Rotation: the refresh token just used is immediately retired, not left valid until its
    // own expiry. A leaked-and-reused old refresh token becomes a revoked-token error instead
    // of silently working -- standard practice for refresh tokens, and cheap here since the
    // revocation store already exists for logout.
    const remainingSeconds = claims.exp - Math.floor(Date.now() / 1000);
    await this.revocation.revoke(claims.jti, remainingSeconds);

    return { accessToken, refreshToken };
  }
}
