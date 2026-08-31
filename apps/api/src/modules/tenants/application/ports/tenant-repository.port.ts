import { Tenant } from "../../domain/tenant.entity.js";
import type { TenantType } from "@crop/shared";

export const TENANT_REPOSITORY = Symbol("TENANT_REPOSITORY");

export interface CreateTenantData {
  name: string;
  type: TenantType;
}

export interface TenantRepositoryPort {
  create(data: CreateTenantData): Promise<Tenant>;
  findById(id: string): Promise<Tenant | null>;
  listAll(): Promise<Tenant[]>;
  deactivate(id: string): Promise<void>;
  reactivate(id: string): Promise<void>;
}
