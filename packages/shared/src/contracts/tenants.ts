import { z } from "zod";
import { BR_STATES } from "../br-states.js";
import { isValidCnpj, normalizeCnpj } from "../cnpj.js";
import { ExamModality, TenantType, UserRole } from "../enums.js";
import { PhoneSchema, ZipCodeSchema } from "./br-address.js";

/**
 * Normalizes to digits-only, then runs the real mod-11 check-digit algorithm (see
 * `cnpj.ts`) -- a typo'd CNPJ is rejected outright, not merely reshaped. Stored as the
 * normalized digits, never the punctuated form; `formatCnpj` is presentation-only.
 */
const CnpjSchema = z
  .string()
  .trim()
  .transform((value) => normalizeCnpj(value))
  .refine((digits) => isValidCnpj(digits), "CNPJ is not valid (check digits do not match)");

/**
 * A clinic's own responsible manager -- denormalized onto the tenant DTO the same way
 * `UnitSchema.technicalManager` is, for the same reason: the listing/detail screens render
 * a name and a registration number without a second round trip per row.
 */
export const ResponsibleManagerOptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  role: z.nativeEnum(UserRole),
  professionalRegistration: z.string().nullable(),
});
export type ResponsibleManagerOption = z.infer<typeof ResponsibleManagerOptionSchema>;

/**
 * `deactivated` is a derived boolean, not the raw `deactivatedAt` timestamp -- same reasoning
 * as `UserSchema`'s `locked`/`mfaEnrolled`: an admin needs to know *whether*, not *exactly
 * when*. Which operating companies may run a clinic's equipment is no longer a field here at
 * all: it is a set of `OperatorAgreement` rows (many-to-many, with an accept/reject handshake and
 * a per-unit/per-equipment scope), read through `GET /agreements`. See contracts/agreements.ts.
 *
 * The institutional/address/manager fields are nullable for the same reason `UnitSchema`'s
 * own are: rows predating this feature, and every `PLATFORM`/`OPERATOR_PROVIDER` tenant
 * (which never has a CNPJ or a clinical address at all), have no honest value for them.
 * `isMatriz`/`cnpjRoot` are `null` in lockstep with `cnpj` -- there is no branch role to
 * derive from a CNPJ that doesn't exist. `equipmentCount`/`unitCount`/`modalities` are
 * computed, the same reasoning as `Unit`'s own `equipmentCount`/`roomCount`: `GET /equipment`
 * is tenant-scoped, so a platform admin viewing another tenant's clinics has no client-side
 * way to derive them.
 */
export const TenantSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: z.nativeEnum(TenantType),
  deactivated: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),

  cnpj: z.string().nullable(),
  institutionalEmail: z.string().nullable(),
  phone: z.string().nullable(),

  zipCode: z.string().nullable(),
  street: z.string().nullable(),
  number: z.string().nullable(),
  complement: z.string().nullable(),
  district: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),

  responsibleManagerId: z.string().uuid().nullable(),
  responsibleManager: ResponsibleManagerOptionSchema.pick({ id: true, name: true, professionalRegistration: true }).nullable(),

  // Derived from `cnpj` -- see cnpj.ts's own docstrings. `null` exactly when `cnpj` is null.
  isMatriz: z.boolean().nullable(),
  cnpjRoot: z.string().nullable(),

  equipmentCount: z.number().int().nonnegative(),
  unitCount: z.number().int().nonnegative(),
  modalities: z.array(z.nativeEnum(ExamModality)),
});
export type TenantDto = z.infer<typeof TenantSchema>;

/**
 * `type` excludes PLATFORM: that's reserved for the one tenant
 * `infra/seeds/bootstrap-superadmin.ts` creates for itself (a second "platform" tenant would
 * just be confusing, not meaningful). CLINIC and OPERATOR_PROVIDER are both real choices, and
 * creating an OPERATOR_PROVIDER is no longer optional flavour: since the role-model inversion
 * (see `roles.ts`) OPERATOR_ADMIN/OPERATIONAL_SUPERVISOR/OPERATOR can belong *only* to an
 * OPERATOR_PROVIDER tenant, so one has to exist before any operator account can. An
 * OPERATOR_PROVIDER still owns no `Equipment`/`Session` of its own -- those remain
 * CLINIC-tenant-scoped -- but its members now reach a clinic's equipment through the operator
 * link plus an active-clinic switch (`SwitchActiveClinicHandler`), rather than by belonging to
 * that clinic outright as the seed data used to model.
 *
 * The institutional/address fields are required, but **only when `type === CLINIC`** --
 * enforced by the `.superRefine` below, since a plain zod object has no way to express
 * "required unless this other field has this other value." An OPERATOR_PROVIDER tenant
 * never has a CNPJ or a clinical address (nothing in this codebase gives it one), so
 * requiring these unconditionally would make that documented, intentional creation path
 * impossible.
 */
const BaseCreateTenantRequestSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum([TenantType.CLINIC, TenantType.OPERATOR_PROVIDER]).default(TenantType.CLINIC),

  cnpj: CnpjSchema.optional(),
  institutionalEmail: z.string().trim().email().optional(),
  phone: PhoneSchema.optional(),

  zipCode: ZipCodeSchema.optional(),
  street: z.string().trim().min(1).optional(),
  number: z.string().trim().min(1).optional(),
  // `.nullish()`, not `.optional()` -- the same reason `Unit`'s own `complement` is: an
  // absent key and an explicit `null` are the same statement for a field whose whole
  // meaning is "may have no value," and accepting only one is the exact trap
  // `CreateEquipmentRequestSchema.aeTitle` fell into before being fixed this way.
  complement: z.string().trim().min(1).nullish(),
  district: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  state: z.enum(BR_STATES).optional(),
});

const CLINIC_REQUIRED_FIELDS = ["cnpj", "institutionalEmail", "phone", "zipCode", "street", "number", "district", "city", "state"] as const;

export const CreateTenantRequestSchema = BaseCreateTenantRequestSchema.superRefine((data, ctx) => {
  if (data.type !== TenantType.CLINIC) return;
  for (const field of CLINIC_REQUIRED_FIELDS) {
    if (data[field] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required when type is CLINIC` });
    }
  }
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;

/**
 * Every field optional -- a real partial update, the same convention every other
 * `Update*RequestSchema` in this codebase uses. Two things are deliberately absent
 * entirely, not merely optional:
 *
 * - **`type`**. Nothing here or in the business rules calls for a clinic becoming an
 *   operator-provider (or vice versa) after the fact, and every role/tenant-type invariant
 *   in `roles.ts` assumes `type` is fixed for a tenant's whole lifetime.
 * - **`cnpj`**. This is the value the matriz/filial derivation and the uniqueness
 *   constraint both key on -- changing it would silently re-parent a clinic's whole branch
 *   group rather than correct a typo. Correcting a wrong CNPJ means creating a new tenant,
 *   the same way `UpdateUnitRequestSchema` has no `clinicTenantId` for the analogous reason.
 *
 * `responsibleManagerId` is the one field that IS nullable here despite being required (for
 * CLINIC) on create: a responsible manager can legitimately become unassigned (the person
 * left), the same asymmetry `UpdateUnitRequestSchema.technicalManagerId` already has and for
 * the same reason. Every other field mirrors create's own required set, correctable but not
 * blankable -- except `complement`, optional even at creation.
 */
export const UpdateTenantRequestSchema = z.object({
  name: z.string().trim().min(1).optional(),
  institutionalEmail: z.string().trim().email().optional(),
  phone: PhoneSchema.optional(),

  zipCode: ZipCodeSchema.optional(),
  street: z.string().trim().min(1).optional(),
  number: z.string().trim().min(1).optional(),
  complement: z.string().trim().min(1).nullable().optional(),
  district: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  state: z.enum(BR_STATES).optional(),

  responsibleManagerId: z.string().uuid().nullable().optional(),
});
export type UpdateTenantRequest = z.infer<typeof UpdateTenantRequestSchema>;

