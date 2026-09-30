import type { AgreementStatus } from "@crop/shared";
import type { OperatorAgreement } from "../../domain/operator-agreement.entity.js";

export const AGREEMENT_REPOSITORY = Symbol("AGREEMENT_REPOSITORY");

export interface CreateAgreementData {
  clinicTenantId: string;
  operatorTenantId: string;
  proposedByTenantId: string;
  proposedByUserId: string | null;
}

export interface AgreementScopeTarget {
  unitId?: string;
  equipmentId?: string;
}

/** What a scope row points at, resolved for display -- see `AgreementScopeSchema.label`. */
export interface ResolvedScopeTarget {
  id: string;
  unitId: string | null;
  equipmentId: string | null;
  label: string;
  modality: string | null;
}

export interface AgreementRepositoryPort {
  findById(id: string): Promise<OperatorAgreement | null>;
  findByPair(clinicTenantId: string, operatorTenantId: string): Promise<OperatorAgreement | null>;

  /** Every agreement either side of which is `tenantId`, newest first. Backs both the clinic's
   * and the operating company's own agreement list -- one query, since "agreements I am party to"
   * is the same question from both directions. */
  listForTenant(tenantId: string, status?: AgreementStatus): Promise<OperatorAgreement[]>;

  /** Clinics this operating company may currently reach. Deliberately narrower than
   * `listForTenant`: this is the hot authorization path (every clinic switch, every equipment
   * read by operator-side staff), so it returns ids only and filters to ACTIVE in SQL. */
  listActiveClinicIdsForOperator(operatorTenantId: string): Promise<string[]>;

  /** The ACTIVE agreement, if any, under which `operatorTenantId` may act inside
   * `clinicTenantId`. Returns the whole aggregate because the caller's next question is always
   * "and does its scope cover this equipment". */
  findActiveForOperatorInClinic(operatorTenantId: string, clinicTenantId: string): Promise<OperatorAgreement | null>;

  create(data: CreateAgreementData): Promise<OperatorAgreement>;

  /** Moves a PENDING agreement to ACTIVE or REJECTED, stamping who answered. */
  recordResponse(id: string, status: AgreementStatus, respondedByUserId: string | null): Promise<OperatorAgreement>;

  revoke(id: string, revokedByUserId: string | null): Promise<OperatorAgreement>;

  /** Re-opens an existing row for a fresh negotiation -- see the model's own comment on why
   * re-proposing reuses the row rather than inserting a second one per pair. */
  reopenAsPending(id: string, proposedByTenantId: string, proposedByUserId: string | null): Promise<OperatorAgreement>;

  /** Replaces the agreement's scope wholesale, in one transaction. A partial add/remove API
   * would need conflict semantics for two admins editing at once; full replacement is idempotent.
   * Validates that every target actually belongs to the agreement's clinic -- the check cannot
   * live only in the handler, since granting another clinic's equipment would otherwise be a
   * cross-tenant escalation written straight into the authorization table. */
  replaceScope(id: string, clinicTenantId: string, targets: AgreementScopeTarget[]): Promise<OperatorAgreement>;

  /** Resolves scope rows to display labels (unit name / equipment name + modality) for the DTO,
   * without the presentation layer reaching into two more repositories. */
  resolveScopeTargets(agreementId: string): Promise<ResolvedScopeTarget[]>;

  /** Tenant display names for the DTO, batched. */
  tenantNames(tenantIds: string[]): Promise<Record<string, string>>;

  /**
   * The three fields a scope decision needs about one piece of equipment, by id.
   *
   * Read through Prisma directly rather than through `EQUIPMENT_REPOSITORY`, deliberately: it lets
   * callers that hold only an equipment *id* (the queue handlers, which load a queue entry and
   * never the device) run the scope check without injecting the equipment repository into each of
   * them, and without AccessModule depending on EquipmentModule -- which depends on AccessModule.
   * Same one-directional choice `PrismaUnitRepository` documents for its own equipment reads.
   */
  findEquipmentForScopeCheck(equipmentId: string): Promise<{ id: string; tenantId: string; unitId: string | null } | null>;

  /**
   * For a set of equipment-level scope grants, which unit (if any) each granted device belongs to.
   *
   * This is what lets `OperatorAccessService.filterReachableUnits` answer "is this unit reachable
   * because one specific scanner in it was granted, even though the unit itself was never granted
   * as a whole" -- a real, legal state (`SetAgreementScopeRequestSchema` allows naming equipment
   * that has a unit without also naming that unit), and one the unit-listing routes must not miss:
   * showing every equipment-level grant's `label` while hiding the very room it sits in would be a
   * confusing, self-contradictory result, not merely an incomplete one.
   */
  resolveEquipmentUnitIds(equipmentIds: string[]): Promise<Map<string, string | null>>;
}
