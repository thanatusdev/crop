import { z } from "zod";
import { AgreementStatus, ExamModality } from "../enums.js";

/**
 * The contract between a clinic and an operating company, and the mechanism by which an
 * `OPERATOR` reaches equipment belonging to a tenant that is not their own.
 *
 * Why this replaced `Tenant.operatorTenantId`: that column was a nullable self-FK, so it could
 * only express "this clinic has at most one operating company". The business rule is
 * many-to-many in both directions -- a clinic contracts several companies, a company serves
 * several clinics -- which a single FK cannot represent no matter how it is read. It also had
 * no handshake (a PLATFORM_ADMIN set it unilaterally) and no way to say that a company may run
 * *this* scanner but not that one.
 *
 * Scope is an explicit allowlist, and an agreement with no scope rows grants nothing. That is
 * deliberate: the safe default for "which of our scanners may an outside company drive" is
 * none, and a clinic that intends to grant everything says so by granting each unit. The
 * migration that converted the old links preserved prior access by writing a unit-level grant
 * for every existing unit, rather than by special-casing "empty means all" -- which would have
 * made the dangerous reading the default forever.
 *
 * A grant is per *unit* or per *equipment*, never both on one row. Equipment-level is the only
 * shape the scope modal offers now: a clinic names exactly which scanners an outside company may
 * drive, and a device installed later grants nothing until named explicitly (deny-by-default).
 *
 * Unit-level grants still exist in the model and are still honored by `grantsAccessTo` -- every
 * agreement that predates this change holds one, and `createContractedOperator`'s test fixture
 * still writes one deliberately, exploiting the old "covers whatever the unit contains, now or
 * later" behavior so tests don't have to re-grant each new piece of equipment they create. A unit
 * grant is converted to the equipment it currently covers the first time an admin opens that
 * agreement's scope in the UI and saves -- see `AgreementScopeOptionSchema.grantedViaUnit`.
 */
export const AgreementScopeSchema = z.object({
  id: z.string().uuid(),
  // Exactly one of these is non-null -- enforced by a CHECK constraint in the migration, not
  // only here, since the database is what other writers (migrations, future admin scripts)
  // actually have to answer to.
  unitId: z.string().uuid().nullable(),
  equipmentId: z.string().uuid().nullable(),
  // Denormalized for display, so an agreement screen can name what it covers without a
  // round trip per row -- same reasoning as `UnitSchema.technicalManager`.
  label: z.string(),
  modality: z.nativeEnum(ExamModality).nullable(),
});
export type AgreementScope = z.infer<typeof AgreementScopeSchema>;

export const OperatorAgreementSchema = z.object({
  id: z.string().uuid(),
  clinicTenantId: z.string().uuid(),
  clinicName: z.string(),
  operatorTenantId: z.string().uuid(),
  operatorName: z.string(),
  status: z.nativeEnum(AgreementStatus),
  // Which side opened the proposal. Needed by the UI to decide whether the viewer is looking
  // at something they must respond to or something they are waiting on: a PENDING agreement is
  // actionable by whichever tenant did *not* propose it.
  proposedByTenantId: z.string().uuid(),
  proposedByUserId: z.string().uuid().nullable(),
  respondedByUserId: z.string().uuid().nullable(),
  respondedAt: z.string().nullable(),
  revokedByUserId: z.string().uuid().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  scopes: z.array(AgreementScopeSchema),
});
export type OperatorAgreementDto = z.infer<typeof OperatorAgreementSchema>;

/**
 * Proposing a contract. The caller supplies only the counterparty -- their own side is taken
 * from their token, never from the body, so neither party can open a contract on someone
 * else's behalf.
 *
 * A clinic admin proposing names an `operatorTenantId`; an operator admin proposing names a
 * `clinicTenantId`. Exactly one, and the handler rejects the combination that does not match
 * the caller's own tenant type.
 */
export const ProposeAgreementRequestSchema = z
  .object({
    clinicTenantId: z.string().uuid().optional(),
    operatorTenantId: z.string().uuid().optional(),
    // Optional initial scope, so a clinic can propose-and-scope in one step. Omitted means an
    // agreement that grants nothing until scope is set -- valid, and the honest default (see
    // the schema docstring above).
    unitIds: z.array(z.string().uuid()).optional(),
    equipmentIds: z.array(z.string().uuid()).optional(),
  })
  .refine((body) => (body.clinicTenantId ? 1 : 0) + (body.operatorTenantId ? 1 : 0) === 1, {
    message: "Name exactly one counterparty: clinicTenantId or operatorTenantId",
  });
export type ProposeAgreementRequest = z.infer<typeof ProposeAgreementRequestSchema>;

/**
 * Replaces an agreement's scope wholesale, the same "send the complete desired state" shape
 * `ReorderQueueRequestSchema` uses. A partial add/remove API would need its own conflict
 * semantics for two admins editing at once; a full replacement is idempotent and has an
 * obvious meaning. An empty payload is a legal way to say "covers nothing".
 */
export const SetAgreementScopeRequestSchema = z.object({
  unitIds: z.array(z.string().uuid()),
  equipmentIds: z.array(z.string().uuid()),
});
export type SetAgreementScopeRequest = z.infer<typeof SetAgreementScopeRequestSchema>;

/**
 * One piece of equipment as a candidate for an agreement's scope -- what `GET
 * /agreements/:id/scope-options` returns, and the data behind the scope modal's equipment picker.
 *
 * `granted`/`grantedViaUnit` are both server-computed so the picker can pre-check exactly what
 * this agreement already covers, by whichever grant shape put it there: `granted` is a scope row
 * naming this equipment directly, `grantedViaUnit` is a scope row naming the unit it currently
 * sits in (the legacy shape -- see `AgreementScopeSchema`'s own docstring). The two are not
 * mutually exclusive -- nothing stops a clinic from granting both a unit and one of its devices --
 * so a picker must OR them to decide what starts checked, and must warn the admin when
 * `grantedViaUnit` is true: `PUT :id/scope` replaces the whole set, so saving without that
 * equipment selected would silently drop the unit grant that used to cover it.
 */
export const AgreementScopeOptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  roomLabel: z.string().nullable(),
  modality: z.nativeEnum(ExamModality).nullable(),
  unitId: z.string().uuid().nullable(),
  unitName: z.string().nullable(),
  granted: z.boolean(),
  grantedViaUnit: z.boolean(),
});
export type AgreementScopeOption = z.infer<typeof AgreementScopeOptionSchema>;

/**
 * The shape behind both "Propor Contrato" pickers -- `GET /agreements/clinic-options` (what an
 * operator admin may propose to) and `GET /agreements/operator-options` (what a clinic admin
 * may propose to). Same `{id, name}` shape either way; which side's tenants it lists is purely
 * a function of which endpoint built it. Deliberately not the full `TenantDto` `GET /tenants`
 * would return (that route is `PLATFORM_ADMIN`-only precisely because it has no tenant-scoping
 * concept at all -- see `TenantsController`'s own docstring) -- this is the narrow, properly
 * -scoped "options" shape the same handful of admin pickers in this app already use (e.g.
 * `ResponsibleManagerOption`), not a second way to enumerate the whole platform's tenants.
 */
export const AgreementCounterpartyOptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type AgreementCounterpartyOption = z.infer<typeof AgreementCounterpartyOptionSchema>;

/** @deprecated Kept as an alias -- use `AgreementCounterpartyOptionSchema`/`AgreementCounterpartyOption`.
 * Named for the operator-side picker only, before the clinic-side one (`GET
 * /agreements/operator-options`) existed to share the same shape. */
export const ClinicAgreementOptionSchema = AgreementCounterpartyOptionSchema;
export type ClinicAgreementOption = AgreementCounterpartyOption;
