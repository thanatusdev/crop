import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { AccessTokenClaims, LoginResponse } from "@crop/shared";
import { api } from "./api-client.js";
import { tokenStore } from "./token-store.js";
import { decodeJwtPayload } from "./jwt.js";
import { detectClientOs } from "./client-platform.js";

/** What `/auth/mfa/verify` actually sends over the wire -- a narrower type than the full
 * `LoginResponse` union, since `mfa_enrollment_required`/`mfa_required` only ever come from
 * `/auth/login`. */
type VerifyMfaApiResponse = Extract<LoginResponse, { status: "ok" }> | Extract<LoginResponse, { status: "password_change_required" }>;

/** What `verifyMfa` below actually returns to its caller -- same two branches, but the "ok"
 * one carries decoded `claims` instead of raw tokens, since LoginPage needs the role to
 * compute its redirect, and re-decoding a token it never received itself would be redundant
 * with the decode this module already does internally. */
export type VerifyMfaOutcome = { status: "ok"; claims: AccessTokenClaims } | Extract<LoginResponse, { status: "password_change_required" }>;

interface AuthState {
  user: AccessTokenClaims | null;
  login: (email: string, password: string) => Promise<LoginResponse>;
  verifyMfa: (mfaToken: string, code: string) => Promise<VerifyMfaOutcome>;
  /** Redeems a `password_change_required` response's `changeToken` -- see
   * ChangePasswordHandler. Both factors were already proven to get that token, so this
   * mints a real session directly, the same way `verifyMfa`'s "ok" branch does. */
  changePassword: (changeToken: string, newPassword: string) => Promise<AccessTokenClaims>;
  confirmEnrollment: (enrollmentToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Re-mints the token pair against a different clinic (`POST /auth/active-clinic`), the same
   * "already authenticated, get a fresh token pair" shape `changePassword` uses. Until now this
   * had zero frontend callers -- `AdminUnitsPage`/`AdminUsersPage`'s own multi-clinic support
   * works by passing an explicit `clinicTenantId` *parameter* to endpoints that accept one, never
   * by switching the active tenant. Equipment, queue and sessions have no such parameter -- they
   * always operate on `user.tenantId` -- so reaching a clinic that is not the caller's own has
   * always required an actual switch, and nothing in the UI could trigger one.
   *
   * That gap was harmless while it only affected a multi-clinic Manager's own equipment tab. It
   * stopped being harmless once OPERATOR/OPERATOR_ADMIN/OPERATIONAL_SUPERVISOR became
   * OPERATOR_PROVIDER-only (see packages/shared/src/roles.ts): their home tenant now owns no
   * equipment at all, ever, so without this call their real working surfaces
   * (`WorkstationPage`, `DashboardPage`) had no way to become non-empty. See `AccessTokenClaims`
   * for what the resulting `tenantId`/`homeTenantId` split means afterwards.
   *
   * `user.tenantId` changing is itself the signal every dependent effect keys on to reconnect its
   * realtime socket and re-fetch tenant-scoped data (see `WorkstationPage`/`DashboardPage`) --
   * this function does not do either of those itself, on purpose: it mints a token, nothing more,
   * the same separation of concerns `verifyMfa`/`changePassword` already keep.
   */
  switchActiveClinic: (clinicTenantId: string) => Promise<AccessTokenClaims>;
}

const AuthContext = createContext<AuthState | null>(null);

function readUserFromStorage(): AccessTokenClaims | null {
  const token = tokenStore.getAccessToken();
  if (!token) return null;
  try {
    return decodeJwtPayload<AccessTokenClaims>(token);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AccessTokenClaims | null>(readUserFromStorage);

  const value = useMemo<AuthState>(
    () => ({
      user,

      login: async (email, password) => {
        return api.post<LoginResponse>("/auth/login", { email, password, clientOs: detectClientOs() }, { auth: false });
      },

      verifyMfa: async (mfaToken, code) => {
        const result = await api.post<VerifyMfaApiResponse>("/auth/mfa/verify", { mfaToken, code }, { auth: false });
        // `password_change_required`: no tokens exist yet -- there is nothing to store, and
        // the caller (LoginPage) is expected to navigate to the forced-change screen with
        // this same result, not treat it as a completed login.
        if (result.status === "password_change_required") return result;

        tokenStore.setTokens(result.accessToken, result.refreshToken);
        // Decoded (not just stored in state) so the caller can redirect off the freshly
        // decoded role immediately -- reading `user` from this same render would still be
        // the pre-login `null`, since setUser's update hasn't committed yet.
        const claims = decodeJwtPayload<AccessTokenClaims>(result.accessToken);
        setUser(claims);
        return { status: "ok", claims };
      },

      changePassword: async (changeToken, newPassword) => {
        const result = await api.post<{ accessToken: string; refreshToken: string }>(
          "/auth/password-change",
          { changeToken, newPassword },
          { auth: false }
        );
        tokenStore.setTokens(result.accessToken, result.refreshToken);
        const claims = decodeJwtPayload<AccessTokenClaims>(result.accessToken);
        setUser(claims);
        return claims;
      },

      confirmEnrollment: async (enrollmentToken, code) => {
        await api.post("/auth/mfa/enroll/confirm", { enrollmentToken, code }, { auth: false });
      },

      switchActiveClinic: async (clinicTenantId) => {
        const result = await api.post<{ accessToken: string; refreshToken: string }>("/auth/active-clinic", { clinicTenantId });
        tokenStore.setTokens(result.accessToken, result.refreshToken);
        const claims = decodeJwtPayload<AccessTokenClaims>(result.accessToken);
        setUser(claims);
        return claims;
      },

      logout: async () => {
        const refreshToken = tokenStore.getRefreshToken();
        if (refreshToken) {
          // Best-effort: revoke server-side so the refresh token can't be replayed, but a
          // logout must always clear local state even if the network call fails (offline,
          // token already expired, etc.) -- the user's intent to leave this browser signed
          // out takes priority over confirming the server-side revocation succeeded.
          try {
            await api.post("/auth/logout", { refreshToken }, { auth: false });
          } catch {
            // ignored -- see above
          }
        }
        tokenStore.clear();
        setUser(null);
      },
    }),
    [user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
