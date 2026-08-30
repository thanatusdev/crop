import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { AccessTokenClaims, LoginResponse } from "@crop/shared";
import { api } from "./api-client.js";
import { tokenStore } from "./token-store.js";
import { decodeJwtPayload } from "./jwt.js";
import { detectClientOs } from "./client-platform.js";

interface AuthState {
  user: AccessTokenClaims | null;
  login: (email: string, password: string) => Promise<LoginResponse>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  confirmEnrollment: (enrollmentToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
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
        const result = await api.post<{ accessToken: string; refreshToken: string }>(
          "/auth/mfa/verify",
          { mfaToken, code },
          { auth: false }
        );
        tokenStore.setTokens(result.accessToken, result.refreshToken);
        setUser(decodeJwtPayload<AccessTokenClaims>(result.accessToken));
      },

      confirmEnrollment: async (enrollmentToken, code) => {
        await api.post("/auth/mfa/enroll/confirm", { enrollmentToken, code }, { auth: false });
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
