import type { UnitDto } from "@crop/shared";
import type { EnrichedUnit } from "../application/unit-enrichment.service.js";

export function toUnitDto(enriched: EnrichedUnit): UnitDto {
  const { unit } = enriched;
  return {
    id: unit.id,
    clinicTenantId: unit.clinicTenantId,
    name: unit.name,
    deactivated: unit.isDeactivated(),
    createdAt: unit.createdAt.toISOString(),
    updatedAt: unit.updatedAt.toISOString(),
    establishmentType: unit.establishmentType,
    technicalManagerId: unit.technicalManagerId,
    technicalManager: enriched.technicalManager,
    declaredModalities: unit.declaredModalities,
    cnesCode: unit.cnesCode,
    phone: unit.phone,
    technicalEmail: unit.technicalEmail,
    zipCode: unit.zipCode,
    street: unit.street,
    number: unit.number,
    complement: unit.complement,
    district: unit.district,
    city: unit.city,
    state: unit.state,
    equipmentCount: enriched.equipmentCount,
    roomCount: enriched.roomCount,
  };
}
