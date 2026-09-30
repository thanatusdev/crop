import type { TenantDto } from "@crop/shared";
import type { EnrichedTenant } from "../application/tenant-enrichment.service.js";

export function toTenantDto(enriched: EnrichedTenant): TenantDto {
  const { tenant } = enriched;
  return {
    id: tenant.id,
    name: tenant.name,
    type: tenant.type,
    deactivated: tenant.isDeactivated(),
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),

    cnpj: tenant.cnpj,
    institutionalEmail: tenant.institutionalEmail,
    phone: tenant.phone,

    zipCode: tenant.zipCode,
    street: tenant.street,
    number: tenant.number,
    complement: tenant.complement,
    district: tenant.district,
    city: tenant.city,
    state: tenant.state,

    responsibleManagerId: tenant.responsibleManagerId,
    responsibleManager: enriched.responsibleManager,

    isMatriz: tenant.isMatriz(),
    cnpjRoot: tenant.cnpjRoot,

    equipmentCount: enriched.equipmentCount,
    unitCount: enriched.unitCount,
    modalities: enriched.modalities,
  };
}
