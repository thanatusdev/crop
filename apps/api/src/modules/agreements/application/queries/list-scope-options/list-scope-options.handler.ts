import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import type { AgreementScopeOption } from "@crop/shared";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { AGREEMENT_REPOSITORY, type AgreementRepositoryPort } from "../../../../access/application/ports/agreement-repository.port.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../../../equipment/application/ports/equipment-repository.port.js";
import { UNIT_REPOSITORY, type UnitRepositoryPort } from "../../../../units/application/ports/unit-repository.port.js";
import { ListScopeOptionsQuery } from "./list-scope-options.query.js";

/**
 * The equipment a clinic can grant an operating company inside one agreement, each flagged with
 * whether this agreement already reaches it and, if so, how.
 *
 * Deliberately **not** `GET /equipment?clinicTenantId=`: that endpoint has no clinic-scoping
 * query param today because nothing needed one -- `EquipmentController` only ever reads the
 * caller's own `user.tenantId`, and `OperatorAccessService.filterReachableEquipment` returns its
 * input *unfiltered* for any caller `isCrossTenantActor` says is not cross-tenant, which is every
 * `CLINIC_ADMIN`. Adding an arbitrary `clinicTenantId` param there would let a clinic admin read
 * any other clinic's inventory just by naming it. This query sidesteps that hole entirely: it
 * authorizes through the agreement itself (`assertScopeCanBeSetBy`, clinic-only) and only then
 * lists *that* agreement's own clinic, so there is no independent tenant parameter to abuse.
 *
 * `granted` is a scope row naming the equipment directly. `grantedViaUnit` is a scope row naming
 * the unit it currently sits in -- the legacy grant shape (see `AgreementScopeSchema`'s own
 * docstring). A picker must OR the two to decide what starts checked, and showing both separately
 * is what lets the UI warn "saving will convert this unit's grant into its current equipment"
 * rather than silently dropping it the first time `PUT :id/scope` replaces the set.
 */
@QueryHandler(ListScopeOptionsQuery)
export class ListScopeOptionsHandler implements IQueryHandler<ListScopeOptionsQuery, AgreementScopeOption[]> {
  constructor(
    @Inject(AGREEMENT_REPOSITORY) private readonly agreements: AgreementRepositoryPort,
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepositoryPort
  ) {}

  async execute(query: ListScopeOptionsQuery): Promise<AgreementScopeOption[]> {
    const agreement = await this.agreements.findById(query.agreementId);
    if (!agreement) throw new NotFoundError("OperatorAgreement", query.agreementId);
    agreement.assertScopeCanBeSetBy(query.actorTenantId);

    const [equipment, units] = await Promise.all([
      this.equipment.listByTenant(agreement.clinicTenantId),
      this.units.listByClinic(agreement.clinicTenantId),
    ]);
    const unitNamesById = new Map(units.map((unit) => [unit.id, unit.name]));

    const grantedEquipmentIds = new Set(agreement.scopes.filter((scope) => scope.equipmentId !== null).map((scope) => scope.equipmentId!));
    const grantedUnitIds = new Set(agreement.scopes.filter((scope) => scope.unitId !== null).map((scope) => scope.unitId!));

    // Not filtered by `isDeactivated()` -- `GET /equipment` (`ListEquipmentHandler`) does not
    // filter it either, and hiding a deactivated device here would be worse than showing one
    // the admin probably doesn't want to grant: a device that already holds a grant (directly
    // or via its unit) would vanish from the picker and get silently dropped the next time this
    // agreement's scope is saved, which is exactly the data loss this endpoint exists to prevent.
    return equipment.map((item) => ({
      id: item.id,
      name: item.name,
      roomLabel: item.roomLabel,
      modality: item.modality,
      unitId: item.unitId,
      unitName: item.unitId ? unitNamesById.get(item.unitId) ?? null : null,
      granted: grantedEquipmentIds.has(item.id),
      grantedViaUnit: item.unitId !== null && grantedUnitIds.has(item.unitId),
    }));
  }
}
