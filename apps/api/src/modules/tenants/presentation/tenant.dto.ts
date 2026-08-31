import type { TenantDto } from "@crop/shared";
import { Tenant } from "../domain/tenant.entity.js";

export function toTenantDto(tenant: Tenant): TenantDto {
  return {
    id: tenant.id,
    name: tenant.name,
    type: tenant.type,
    deactivated: tenant.isDeactivated(),
    createdAt: tenant.createdAt.toISOString(),
  };
}
