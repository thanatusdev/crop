import { AgreementStatus } from "@crop/shared";
import { ForbiddenError } from "../../../shared/domain/errors.js";

/**
 * One grant inside an agreement: a unit, or a single piece of equipment, never both.
 *
 * Equipment-level is the only shape the scope modal offers now -- see
 * `AgreementScopeSchema`'s own docstring in packages/shared for why, and for
 * `grantedViaUnit`'s role in converting a legacy unit grant the first time an admin opens and
 * saves it. Unit-level rows still exist and are still fully honored here (`grantsAccessTo`
 * below): every agreement that predates this change holds one, and this codebase's own test
 * fixture (`createContractedOperator`/`grantWholeClinicScope`, apps/api/test/helpers.ts) still
 * writes one deliberately, because a unit grant keeps covering whatever equipment that room
 * gains later and a fixture used by ~30 spec files should not have to re-grant each new device
 * those specs create.
 */
export interface AgreementScopeProps {
  id: string;
  unitId: string | null;
  equipmentId: string | null;
}

export interface OperatorAgreementProps {
  id: string;
  clinicTenantId: string;
  operatorTenantId: string;
  status: AgreementStatus;
  proposedByTenantId: string;
  proposedByUserId: string | null;
  respondedByUserId: string | null;
  respondedAt: Date | null;
  revokedByUserId: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  scopes: AgreementScopeProps[];
}

/**
 * The contract between a clinic and an operating company -- see schema.prisma's own comment on
 * the `OperatorAgreement` model for why this replaced `Tenant.operatorTenantId`.
 *
 * The invariants that make this a contract rather than a unilateral grant live here as
 * assertion methods, not in the handlers: "only the other side may respond" and "only an active
 * agreement grants access" are properties of the agreement itself, and a second caller (a future
 * admin script, a bulk revoke) must not be able to reach a different conclusion by forgetting a
 * check.
 */
export class OperatorAgreement {
  constructor(private readonly props: OperatorAgreementProps) {}

  get id(): string {
    return this.props.id;
  }

  get clinicTenantId(): string {
    return this.props.clinicTenantId;
  }

  get operatorTenantId(): string {
    return this.props.operatorTenantId;
  }

  get status(): AgreementStatus {
    return this.props.status;
  }

  get proposedByTenantId(): string {
    return this.props.proposedByTenantId;
  }

  get proposedByUserId(): string | null {
    return this.props.proposedByUserId;
  }

  get respondedByUserId(): string | null {
    return this.props.respondedByUserId;
  }

  get respondedAt(): Date | null {
    return this.props.respondedAt;
  }

  get revokedByUserId(): string | null {
    return this.props.revokedByUserId;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get scopes(): readonly AgreementScopeProps[] {
    return this.props.scopes;
  }

  isActive(): boolean {
    return this.props.status === AgreementStatus.ACTIVE;
  }

  /** True if `tenantId` is either party to this contract -- the precondition for seeing it at all. */
  involves(tenantId: string): boolean {
    return this.props.clinicTenantId === tenantId || this.props.operatorTenantId === tenantId;
  }

  /**
   * Does this agreement grant access to a given piece of equipment?
   *
   * Both conditions matter and neither is redundant: the agreement must be ACTIVE (a PENDING
   * proposal, a rejection, or a revoked contract grants nothing), and the equipment must fall
   * inside scope either by being named directly or by sitting in a granted unit. Equipment with
   * no unit at all (`unitId: null`, legal -- see the Equipment model) can only ever match the
   * direct form, which is exactly why the conversion migration had to write equipment-level
   * rows for those devices instead of relying on unit grants.
   */
  grantsAccessTo(equipment: { id: string; tenantId: string; unitId: string | null }): boolean {
    if (!this.isActive()) return false;
    if (equipment.tenantId !== this.props.clinicTenantId) return false;
    return this.props.scopes.some(
      (scope) =>
        scope.equipmentId === equipment.id || (equipment.unitId !== null && scope.unitId === equipment.unitId)
    );
  }

  /**
   * A PENDING proposal may be answered only by the side that did *not* open it. Without this,
   * either party could accept its own proposal and the handshake would be decoration -- which is
   * precisely the weakness of the `Tenant.operatorTenantId` column this model replaced, where one
   * party (a platform admin, in practice) decided alone.
   */
  assertCanBeRespondedToBy(tenantId: string): void {
    if (this.props.status !== AgreementStatus.PENDING) {
      throw new ForbiddenError(`This agreement is ${this.props.status}, not pending a response`);
    }
    if (!this.involves(tenantId)) {
      throw new ForbiddenError("You are not a party to this agreement");
    }
    if (this.props.proposedByTenantId === tenantId) {
      throw new ForbiddenError("You proposed this agreement -- the other party must respond to it");
    }
  }

  /**
   * Revocation is unilateral, unlike acceptance: either party may end a live contract without the
   * other's consent. A clinic must be able to cut off an outside company immediately, and an
   * operating company must be able to walk away from an engagement -- requiring agreement to
   * *stop* would mean a clinic could be held to an operator it no longer trusts.
   */
  assertCanBeRevokedBy(tenantId: string): void {
    if (this.props.status !== AgreementStatus.ACTIVE) {
      throw new ForbiddenError(`Only an active agreement can be revoked; this one is ${this.props.status}`);
    }
    if (!this.involves(tenantId)) {
      throw new ForbiddenError("You are not a party to this agreement");
    }
  }

  /**
   * Scope is the clinic's to set, and only the clinic's. The operating company is the party whose
   * reach is being limited, so letting it widen its own scope would make the limit meaningless --
   * this is the one asymmetry in an otherwise two-sided model, and it is the whole point of
   * having scope at all.
   */
  assertScopeCanBeSetBy(tenantId: string): void {
    if (this.props.clinicTenantId !== tenantId) {
      throw new ForbiddenError("Only the clinic can change what an agreement covers");
    }
    if (this.props.status === AgreementStatus.REJECTED || this.props.status === AgreementStatus.REVOKED) {
      throw new ForbiddenError(`Cannot change the scope of a ${this.props.status} agreement`);
    }
  }
}
