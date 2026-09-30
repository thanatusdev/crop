import { z } from "zod";
import { BR_STATES } from "../br-states.js";
import { EstablishmentType, ExamModality, UserRole } from "../enums.js";
import { PhoneSchema, ZipCodeSchema } from "./br-address.js";

/**
 * A clinic's own sub-site ("like a hospital" -- a clinic/company can run more than one),
 * always scoped to one clinic tenant. Equipment belongs to a unit (see
 * `EquipmentSchema.unitId`), not directly to the clinic, so an operator's navigation is
 * clinic -> unit -> equipment. See `schema.prisma`'s `Unit` model for why clinic-side user
 * membership stays clinic-level rather than unit-level.
 */
export const UnitSchema = z.object({
  id: z.string().uuid(),
  clinicTenantId: z.string().uuid(),
  name: z.string(),
  deactivated: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),

  // Nullable for rows that predate this feature (see the unit_registry migration's own
  // note) -- required through the HTTP create path from here on, so the null set only ever
  // shrinks. `technicalManager` is denormalized here (id/name/registration), not just an id,
  // so the listing and detail screens can render a name without a second round trip per
  // unit -- the same reasoning `EquipmentDto.deactivated` is a computed boolean rather than
  // making every caller re-derive it from `deactivatedAt`.
  establishmentType: z.nativeEnum(EstablishmentType).nullable(),
  technicalManagerId: z.string().uuid().nullable(),
  technicalManager: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      professionalRegistration: z.string().nullable(),
    })
    .nullable(),
  // What this unit is declared to be equipped for -- independent of, and shown alongside,
  // what its actual `Equipment` rows report via their own `modality`. See ExamModality's
  // own docstring for why the two are not merged into one source of truth.
  declaredModalities: z.array(z.nativeEnum(ExamModality)),

  cnesCode: z.string().nullable(),
  phone: z.string().nullable(),
  technicalEmail: z.string().nullable(),

  zipCode: z.string().nullable(),
  street: z.string().nullable(),
  number: z.string().nullable(),
  complement: z.string().nullable(),
  district: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),

  // Computed server-side, not something the client can set directly -- see
  // ListUnitsByClinicHandler/GetUnitHandler for how each is derived. `equipmentCount` is
  // this API's first aggregate query (a `groupBy`); `roomCount` counts distinct non-blank
  // `roomLabel` values among the unit's *non-retired* equipment, so a decommissioned
  // scanner doesn't keep a room in the total.
  equipmentCount: z.number().int().nonnegative(),
  roomCount: z.number().int().nonnegative(),
});
export type UnitDto = z.infer<typeof UnitSchema>;

/**
 * One candidate for "Gestor Técnico Local" -- returned by `GET /units/technical-managers`,
 * not embedded in `UnitSchema` itself (that carries only the *chosen* manager, denormalized).
 * Eligibility (CLINIC_ADMIN / LOCAL_SUPERVISOR / LOCAL_IT, activated, not locked) is applied
 * server-side by `ListTechnicalManagerOptionsHandler`, not left to the client to filter.
 *
 * `professionalRegistration` is shown as-is, with no verification badge: nothing in this
 * platform checks a CFM/CRM registration against any registry (the prototype's
 * "CREDENCIAÇÃO CFM OK" badge is exactly the kind of unbacked claim this codebase has
 * already, elsewhere, deliberately declined to reproduce -- see docs/architecture.md).
 */
export const TechnicalManagerOptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  role: z.nativeEnum(UserRole),
  professionalRegistration: z.string().nullable(),
});
export type TechnicalManagerOption = z.infer<typeof TechnicalManagerOptionSchema>;

export const CreateUnitRequestSchema = z.object({
  name: z.string().trim().min(1),
  // Optional -- defaults to the caller's own home/active clinic (UnitsController). Present
  // so a multi-clinic Manager can create a unit under a clinic other than their home one;
  // CreateUnitHandler still checks it's a real, active CLINIC tenant.
  clinicTenantId: z.string().uuid().optional(),

  // Required from here on -- the whole point of the registration screen is that a unit's
  // institutional identity is known at the moment it's registered. Nullable in the database
  // only for rows that predate this (see the unit_registry migration).
  establishmentType: z.nativeEnum(EstablishmentType),
  technicalManagerId: z.string().uuid(),
  declaredModalities: z.array(z.nativeEnum(ExamModality)).min(1, "Select at least one modality"),

  zipCode: ZipCodeSchema,
  street: z.string().trim().min(1),
  number: z.string().trim().min(1),
  // `.nullish()`, not `.optional()`: an absent key and an explicit `null` are the same
  // statement for a field whose whole meaning is "may have no value," and accepting only
  // one of the two is exactly the trap `CreateEquipmentRequestSchema.aeTitle` fell into
  // before being fixed the same way -- a form that (reasonably) sends `{complement: null}`
  // for an empty input would otherwise 400 on create while working fine on update, since
  // `UpdateUnitRequestSchema` already accepts null here.
  complement: z.string().trim().min(1).nullish(),
  district: z.string().trim().min(1),
  city: z.string().trim().min(1),
  state: z.enum(BR_STATES),

  // Optional even for a new unit -- CNES/phone/e-mail are regulatory/contact metadata, not
  // something the platform itself reads for anything, the same status DICOM fields have on
  // Equipment. `.nullish()` for the same reason as `complement` above.
  cnesCode: z.string().trim().min(1).nullish(),
  phone: PhoneSchema.nullish(),
  technicalEmail: z.string().trim().email().nullish(),
});
export type CreateUnitRequest = z.infer<typeof CreateUnitRequestSchema>;

/**
 * Every field optional -- a real partial update, not "resend everything," the same
 * convention `UpdateEquipmentRequestSchema` uses.
 *
 * There is deliberately no `clinicTenantId` here at all -- not even as a settable field.
 * Reassigning a unit to a different clinic would leave its equipment's own `tenantId`
 * (which every tenant-isolation check in this codebase keys on -- `belongsToTenant`, the
 * audit trail, ~20 call sites) pointing at the *old* clinic while `unit.clinicTenantId`
 * pointed at the new one, and reconciling that is a real migration this feature was never
 * asked to build. A unit's clinic is fixed at creation.
 *
 * `technicalManagerId` is the one required-on-create field that IS nullable here: a
 * technical manager can legitimately become unassigned (the person left the clinic) in a
 * way a brand or an address cannot legitimately become blank. Every other required-on-create
 * field may be corrected but not blanked, matching the equipment contract's own rule for the
 * same reason -- see `UpdateEquipmentRequestSchema`'s docstring. `cnesCode`/`phone`/
 * `technicalEmail` are nullable too, since "actually, we don't have this on file" is a
 * legitimate correction for optional contact metadata, same as Equipment's DICOM trio.
 */
export const UpdateUnitRequestSchema = z.object({
  name: z.string().trim().min(1).optional(),

  establishmentType: z.nativeEnum(EstablishmentType).optional(),
  technicalManagerId: z.string().uuid().nullable().optional(),
  declaredModalities: z.array(z.nativeEnum(ExamModality)).min(1).optional(),

  zipCode: ZipCodeSchema.optional(),
  street: z.string().trim().min(1).optional(),
  number: z.string().trim().min(1).optional(),
  complement: z.string().trim().min(1).nullable().optional(),
  district: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  state: z.enum(BR_STATES).optional(),

  cnesCode: z.string().trim().min(1).nullable().optional(),
  phone: PhoneSchema.nullable().optional(),
  technicalEmail: z.string().trim().email().nullable().optional(),
});
export type UpdateUnitRequest = z.infer<typeof UpdateUnitRequestSchema>;
