import { z } from "zod";
import { TenantType } from "../enums.js";

/**
 * `deactivated` is a derived boolean, not the raw `deactivatedAt` timestamp -- same reasoning
 * as `UserSchema`'s `locked`/`mfaEnrolled`: an admin needs to know *whether*, not *exactly
 * when*.
 */
export const TenantSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: z.nativeEnum(TenantType),
  deactivated: z.boolean(),
  createdAt: z.string(),
});
export type TenantDto = z.infer<typeof TenantSchema>;

/**
 * `type` is deliberately restricted to CLINIC, not the full `TenantType` enum: `PLATFORM` is
 * reserved for the one tenant `infra/seeds/bootstrap-superadmin.ts` creates for itself (a
 * second "platform" tenant would just be confusing, not meaningful), and `OPERATOR_PROVIDER`
 * has no defined behavior anywhere in this codebase yet -- exposing it as a choice here would
 * be offering a no-op. Easy to widen later once it means something.
 */
export const CreateTenantRequestSchema = z.object({
  name: z.string().min(1),
  type: z.literal(TenantType.CLINIC).default(TenantType.CLINIC),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;
