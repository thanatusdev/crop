import { z } from "zod";
import { TargetOs, UserRole } from "../enums.js";
import { StrongPasswordSchema } from "./password.js";

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
  // Both factors just passed, but the password itself can't be used to start a session yet
  // -- either an admin issued it as a temp credential (`reason: "must_change"`, which also
  // covers a brand-new account's first login) or it's simply too old
  // (`reason: "expired"`, PASSWORD_MAX_AGE_DAYS). See VerifyMfaHandler. Identity fields
  // travel in this response rather than needing a second lookup: the caller has already
  // proved password + TOTP, which is strictly more than the reset-flow's `validate`
  // endpoint requires, so there's no reason to make them ask twice.
  z.object({
    status: z.literal("password_change_required"),
    changeToken: z.string(),
    reason: z.enum(["must_change", "expired"]),
    email: z.string().email(),
    role: z.nativeEnum(UserRole),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    professionalRegistration: z.string().nullable(),
  }),
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

/**
 * Deliberately no `exists`/`sent` boolean in the response: the handler behind this always
 * responds the same way whether or not `email` belongs to a real account (see
 * RequestPasswordResetHandler) -- a distinguishable response here would make this endpoint
 * an email-enumeration oracle. The frontend's confirmation modal echoes back what the user
 * typed, not anything the server confirmed.
 */
export const RequestPasswordResetRequestSchema = z.object({
  email: z.string().email(),
});
export type RequestPasswordResetRequest = z.infer<typeof RequestPasswordResetRequestSchema>;

/** Policy enforced by `StrongPasswordSchema`; the fifth rule (no personal info) and reuse
 * prevention need the loaded account/history and live in ResetPasswordHandler instead --
 * see that schema's own docstring. */
export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(1),
  newPassword: StrongPasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

/**
 * What `GET /auth/password-reset/validate` returns for a token that's still good --
 * required, not convenience: only the server knows whether the token was already redeemed
 * (the Redis `pwreset` denylist), so without this a spent link would render a fully working
 * form that only fails on submit. Not an email-enumeration path -- it requires a
 * validly-signed token, which can't be forged, and reveals nothing to anyone who doesn't
 * already have the account owner's inbox link. Returns names (nullable -- see `User`'s own
 * comment) so the browser can evaluate the personal-info rule live, with the same function
 * the server enforces.
 */
export const PasswordResetValidateResponseSchema = z.object({
  email: z.string().email(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  role: z.nativeEnum(UserRole),
  professionalRegistration: z.string().nullable(),
  expiresAt: z.string().datetime(),
});
export type PasswordResetValidateResponse = z.infer<typeof PasswordResetValidateResponseSchema>;

/**
 * Redeems a `password_change_required` response's `changeToken` (see `LoginResponseSchema`).
 * No current password: the caller already proved both factors (password + TOTP) to get this
 * token in the first place, so asking for the password a second time would be redundant, not
 * safer.
 */
export const ChangePasswordRequestSchema = z.object({
  changeToken: z.string().min(1),
  newPassword: StrongPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/** Decoded JWT access token claims. `tenantId` is what enforces multi-tenant isolation --
 * for a multi-clinic account (see `UserClinicMembership`) this is specifically the
 * *currently active* clinic, not necessarily the user's only one; see
 * `SwitchActiveClinicRequestSchema` for how it changes. */
export interface AccessTokenClaims {
  sub: string; // userId
  tenantId: string;
  role: UserRole;
  clientOs: TargetOs; // detected operator platform, used for modifier remap decisions
  /**
   * The tenant this account actually *belongs to*, as opposed to `tenantId`, which is the tenant
   * it is currently acting inside.
   *
   * For almost every account these are the same value. They diverge for exactly one case, and it
   * is the case this claim exists for: a contracted operator, who belongs to an
   * OPERATOR_PROVIDER tenant but works inside a clinic's context so that the ~30 existing
   * `belongsToTenant` checks keep applying unmodified (see `SwitchActiveClinicHandler`). Once
   * that happens, `tenantId` alone can no longer tell a clinic's own staff apart from an outside
   * company operating that clinic -- both present the clinic's id -- and `OperatorAccessService`
   * needs precisely that distinction to decide whether an agreement must justify the access.
   *
   * Optional so that tokens minted before this claim existed still verify. Absent is read as
   * "not cross-tenant", which is safe rather than permissive: the only way to hold a clinic's
   * `tenantId` under the old flow was to belong to that clinic.
   */
  homeTenantId?: string;
}

/**
 * `GET /auth/me` -- the caller's own identity, for the nursing screen's header ("Enfª
 * Camila Rocha · COREN-SP 148209") and anywhere else a role needs to display its own name/
 * registration without the admin-only `GET /users`/`GET /users/:id` it very likely can't
 * call (`UsersController`'s `@Roles` is `PLATFORM_ADMIN`/`CLINIC_ADMIN`/`OPERATOR_ADMIN`
 * only -- `NURSING` is not in it, and never should be, since that route can look up *any*
 * user in the tenant, not just the caller). This route is self-scoped by construction: the
 * handler reads `AccessTokenClaims.sub` and nothing else, so no new authorization surface
 * exists for any role -- it can only ever answer "who am I", never "who is user X".
 */
export const MeResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: z.nativeEnum(UserRole),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  professionalRegistration: z.string().nullable(),
  tenantId: z.string().uuid(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** `POST /auth/active-clinic` -- re-mints the caller's token pair against a different
 * clinic they're linked to (see `UserClinicMembership`), without a full re-login. The
 * target must be one of the caller's own clinics; `SwitchActiveClinicHandler` is what
 * actually enforces that. */
export const SwitchActiveClinicRequestSchema = z.object({
  clinicTenantId: z.string().uuid(),
});
export type SwitchActiveClinicRequest = z.infer<typeof SwitchActiveClinicRequestSchema>;

/** `GET /auth/me/clinics` -- every clinic the caller can switch into (their home tenant
 * plus every `UserClinicMembership` row), for rendering the clinic switcher. `active`
 * marks whichever one the caller's *current* access token is scoped to. */
export const MyClinicSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  deactivated: z.boolean(),
  active: z.boolean(),
});
export type MyClinic = z.infer<typeof MyClinicSchema>;
