import { z } from "zod";
import { TargetOs, UserRole } from "../enums.js";

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  /** Operator's browser platform, used server-side for the Control/Cmd modifier remap. */
  clientOs: z.nativeEnum(TargetOs).default(TargetOs.WINDOWS),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.discriminatedUnion("status", [
  // 2FA is mandatory platform-wide (see docs/architecture.md). A freshly created user has a
  // generated secret but hasn't confirmed it yet -- this branch carries what the frontend
  // needs to render the enrollment QR code, once, before any session token is ever issued.
  z.object({
    status: z.literal("mfa_enrollment_required"),
    enrollmentToken: z.string(),
    provisioningUri: z.string(),
  }),
  z.object({ status: z.literal("mfa_required"), mfaToken: z.string() }),
  z.object({
    status: z.literal("ok"),
    accessToken: z.string(),
    refreshToken: z.string(),
  }),
]);
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const MfaVerifyRequestSchema = z.object({
  mfaToken: z.string(),
  code: z.string().length(6).regex(/^\d{6}$/),
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

export const MfaEnrollConfirmRequestSchema = z.object({
  enrollmentToken: z.string(),
  code: z.string().length(6).regex(/^\d{6}$/),
});
export type MfaEnrollConfirmRequest = z.infer<typeof MfaEnrollConfirmRequestSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string(),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/** Decoded JWT access token claims. `tenantId` is what enforces multi-tenant isolation. */
export interface AccessTokenClaims {
  sub: string; // userId
  tenantId: string;
  role: UserRole;
  clientOs: TargetOs; // detected operator platform, used for modifier remap decisions
}
