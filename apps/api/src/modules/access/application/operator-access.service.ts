import { Inject, Injectable } from "@nestjs/common";
import { OPERATOR_PROVIDER_ROLES, type AccessTokenClaims } from "@crop/shared";
import { ForbiddenError } from "../../../shared/domain/errors.js";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "./ports/agreement-repository.port.js";

/** The shape every caller already has to hand -- deliberately not the `Equipment` entity, so
 * queue handlers (which hold an equipment row for a different reason) and equipment handlers can
 * both call this without either module depending on the other's domain class. */
export interface ScopedEquipment {
  id: string;
  tenantId: string;
  unitId: string | null;
}

/**
 * Answers "may this actor reach this clinic / this equipment", for actors whose reach comes from a
 * contract rather than from owning the data.
 *
 * **Why a single service, and how it knows an actor is cross-tenant.** A contracted operator works
 * by switching into the clinic's context, so their access token's `tenantId` claim *is* the
 * clinic -- which is exactly what lets all 30 existing `belongsToTenant` checks keep working
 * unmodified (see SwitchActiveClinicHandler). The consequence is that tenancy alone can no longer
 * distinguish "this clinic's own staff" from "an outside company operating this clinic": both
 * present the same `tenantId`. `homeTenantId` is what separates them -- it is the tenant the
 * account actually belongs to, and it differs from `tenantId` precisely when the caller is
 * working inside someone else's clinic.
 *
 * So the rule implemented below is: if `homeTenantId === tenantId`, or the caller's role is not
 * one Phase 1 confined to operator-provider tenants, there is nothing for this service to add
 * (either the caller owns the data, or their tenant mismatch is a clinic-membership switch this
 * service has no business narrowing); otherwise an ACTIVE agreement must exist *and* its scope
 * must cover the specific equipment. Tenancy stays the coarse check; the agreement is the fine
 * one. See `isCrossTenantActor`'s own docstring for the real bug that made the role half of this
 * rule necessary, not just tidy.
 *
 * Deriving "is this cross-tenant" from a claim rather than a per-request user lookup is the reason
 * this is cheap enough to call on hot paths (every equipment read, every session start). The
 * alternative -- loading the user to find their home tenant -- would put an extra query in front
 * of every one of those, and would also make this service depend on IamModule, which depends on
 * this one.
 */
@Injectable()
export class OperatorAccessService {
  constructor(@Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort) {}

  /**
   * True when the caller's reach into their *active* tenant has to be justified by a contract,
   * as opposed to real membership.
   *
   * **A real bug this method used to have, found live rather than by review.** The first version
   * read only `homeTenantId !== tenantId` -- true whenever the caller has switched away from their
   * home tenant, *for any reason*. That is also true of a plain multi-clinic `CLINIC_ADMIN`
   * switching between two clinics they hold a genuine `UserClinicMembership` row for (Alpha home,
   * also linked to Beta) -- a relationship with no `OperatorAgreement` behind it at all, because
   * none is possible between two `CLINIC` tenants. Every equipment/unit read this service gates
   * therefore came back empty for that manager the moment they switched, in a codebase that had no
   * frontend caller of `switchActiveClinic` before this feature existed to actually exercise the
   * path -- 262 passing backend tests never caught it because none of them switched a clinic-side
   * membership account and then read equipment through the *live* stack; it surfaced only once a
   * real browser drove `WorkstationPage`'s clinic step end to end.
   *
   * The fix: also require the caller's own *role* to be one Phase 1's role-model inversion confines
   * to `OPERATOR_PROVIDER` tenants (`ROLE_TENANT_TYPES`, packages/shared/src/roles.ts). Only those
   * roles can ever have an `OperatorAgreement` on the other end of a tenant switch; every other
   * role's `tenantId`/`homeTenantId` mismatch is `UserClinicMembership`'s business, checked
   * elsewhere (`ClinicAccessChecker`), and must pass through this service untouched.
   */
  isCrossTenantActor(actor: AccessTokenClaims): boolean {
    // Tokens minted before `homeTenantId` existed have it undefined. Treating that as "not
    // cross-tenant" is the correct fallback rather than a security hole: such a token can only
    // have come from the pre-agreement login flow, where the only way to hold a clinic's
    // `tenantId` was to belong to that clinic.
    if (actor.homeTenantId === undefined || actor.homeTenantId === actor.tenantId) return false;
    // Role is a proxy for "home tenant is really OPERATOR_PROVIDER" -- exact for the three roles
    // checked here, because ROLE_TENANT_TYPES guarantees it, but imprecise for AUDITOR, which is
    // deliberately valid in either tenant type (see roles.ts). An AUDITOR whose home happens to be
    // an OPERATOR_PROVIDER tenant with its own agreements, switched into a clinic that agreement
    // covers, is treated as NOT cross-tenant here and so sees that clinic's equipment unscoped --
    // wider than the very operators such an auditor exists to audit. Narrower and one-sided (an
    // auditor seeing more, not an unauthorized party seeing anything at all), unexercised by any
    // seed data or test in this codebase today, and deliberately not fixed by adding a tenant-type
    // lookup here: that is exactly the per-call query this method exists to avoid on equipment's
    // hottest read path (see the class docstring). Flagged rather than silently accepted.
    return OPERATOR_PROVIDER_ROLES.includes(actor.role);
  }

  /**
   * Narrows a list of the active clinic's equipment to what the caller may actually reach.
   *
   * Filtering rather than throwing, because this backs `GET /equipment`: a contracted operator
   * whose agreement covers one of three rooms should see one room, not an error. The 403 belongs
   * on the single-resource path (`assertCanReachEquipment`), where the caller named something
   * specific and deserves to be told no.
   */
  async filterReachableEquipment<T extends ScopedEquipment>(actor: AccessTokenClaims, equipment: T[]): Promise<T[]> {
    if (!this.isCrossTenantActor(actor)) return equipment;
    const agreement = await this.agreements.findActiveForOperatorInClinic(actor.homeTenantId!, actor.tenantId);
    if (!agreement) return [];
    return equipment.filter((item) => agreement.grantsAccessTo(item));
  }

  /**
   * Refuses the request unless the caller may reach this specific equipment.
   *
   * The two failure modes are reported differently on purpose. No agreement at all is a statement
   * about the relationship ("you are not contracted to this clinic"); an agreement that does not
   * cover this device is a statement about scope. Collapsing them into one message would make a
   * misconfigured scope indistinguishable from a revoked contract, which is the first thing
   * someone debugging this will need to tell apart.
   */
  async assertCanReachEquipment(actor: AccessTokenClaims, equipment: ScopedEquipment): Promise<void> {
    if (!this.isCrossTenantActor(actor)) return;

    const agreement = await this.agreements.findActiveForOperatorInClinic(actor.homeTenantId!, actor.tenantId);
    if (!agreement) {
      throw new ForbiddenError("Your organisation has no active agreement with this clinic");
    }
    if (!agreement.grantsAccessTo(equipment)) {
      throw new ForbiddenError("This equipment is outside the scope of your organisation's agreement with this clinic");
    }
  }

  /**
   * The same check as `assertCanReachEquipment`, for callers holding only an equipment id.
   *
   * Exists for the queue handlers: they load a `QueueEntry`, never the device, so requiring the
   * full equipment row would have meant injecting the equipment repository into five more handlers
   * purely to satisfy an authorization check. A missing device is not treated as "allowed" -- an
   * id that resolves to nothing is refused, because the alternative (falling through to a
   * permissive default when a lookup fails) is how this kind of check silently stops working.
   */
  async assertCanReachEquipmentId(actor: AccessTokenClaims, equipmentId: string): Promise<void> {
    if (!this.isCrossTenantActor(actor)) return;
    const equipment = await this.agreements.findEquipmentForScopeCheck(equipmentId);
    if (!equipment) {
      throw new ForbiddenError("This equipment is outside the scope of your organisation's agreement with this clinic");
    }
    await this.assertCanReachEquipment(actor, equipment);
  }

  /**
   * Narrows a list of the active clinic's units to the ones the caller may actually reach --
   * i.e. either the unit itself is granted, or at least one piece of equipment inside it is
   * (a legal, separate grant shape: naming one scanner without naming its whole room). Without
   * this, `GET /units` told a contracted operator about rooms their agreement never mentioned --
   * a real gap Phase 2 left, since only equipment reads were scope-filtered there. Names/room
   * labels are lower-sensitivity than a patient queue, but "which rooms exist in this clinic" is
   * still exactly the kind of fact an agreement with a narrower scope is supposed to withhold.
   *
   * Filtering, not throwing -- same reasoning as `filterReachableEquipment`: a contracted
   * operator whose agreement covers one of three rooms should see one room, not an error.
   */
  async filterReachableUnits<T extends { id: string }>(actor: AccessTokenClaims, units: T[]): Promise<T[]> {
    if (!this.isCrossTenantActor(actor)) return units;
    const agreement = await this.agreements.findActiveForOperatorInClinic(actor.homeTenantId!, actor.tenantId);
    if (!agreement) return [];

    const directUnitIds = new Set(agreement.scopes.filter((s) => s.unitId !== null).map((s) => s.unitId!));
    const grantedEquipmentIds = agreement.scopes.filter((s) => s.equipmentId !== null).map((s) => s.equipmentId!);
    const equipmentUnitIds = await this.agreements.resolveEquipmentUnitIds(grantedEquipmentIds);
    const indirectUnitIds = new Set([...equipmentUnitIds.values()].filter((id): id is string => id !== null));

    return units.filter((unit) => directUnitIds.has(unit.id) || indirectUnitIds.has(unit.id));
  }

  /** The single-resource counterpart to `filterReachableUnits`, for `GET /units/:id` -- refuses
   * rather than filters, the same split `assertCanReachEquipment` draws against
   * `filterReachableEquipment`: naming one specific unit and being told no is a different, more
   * informative outcome than a unit silently missing from a list. */
  async assertCanReachUnit(actor: AccessTokenClaims, unit: { id: string }): Promise<void> {
    if (!this.isCrossTenantActor(actor)) return;
    const reachable = await this.filterReachableUnits(actor, [unit]);
    if (reachable.length === 0) {
      throw new ForbiddenError("This unit is outside the scope of your organisation's agreement with this clinic");
    }
  }

  /** Clinics an operating company may currently act inside -- the set `GET /auth/me/clinics` and
   * `POST /auth/active-clinic` both consult. */
  async listAccessibleClinicIdsForOperator(operatorTenantId: string): Promise<string[]> {
    return this.agreements.listActiveClinicIdsForOperator(operatorTenantId);
  }

  /** Whether `operatorTenantId` holds a live contract with `clinicTenantId`. Used by the
   * clinic-access checks, which ask about the relationship without naming any equipment. */
  async hasActiveAgreement(operatorTenantId: string, clinicTenantId: string): Promise<boolean> {
    return (await this.agreements.findActiveForOperatorInClinic(operatorTenantId, clinicTenantId)) !== null;
  }
}
