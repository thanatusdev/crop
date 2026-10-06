import { Inject, Injectable } from "@nestjs/common";
import type { ExamModality } from "@crop/shared";
import type { ResponsibleManagerSummary } from "./ports/tenant-repository.port.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "./ports/tenant-repository.port.js";
import { Tenant } from "../domain/tenant.entity.js";

/**
 * A tenant plus the read-model data `TenantSchema` denormalizes onto it
 * (`equipmentCount`/`unitCount`/`modalities`/`responsibleManager`) but that isn't part of
 * the domain entity itself -- the tenant-side counterpart to `UnitEnrichmentService`, same
 * reasoning and same shape.
 */
export interface EnrichedTenant {
  tenant: Tenant;
  equipmentCount: number;
  unitCount: number;
  modalities: ExamModality[];
  activeAgreementCount: number;
  userCount: number;
  responsibleManager: ResponsibleManagerSummary | null;
}

/**
 * Shared by every command/query handler that returns one or more tenants to a caller, so
 * the enrichment logic -- and its three batched repository calls -- exists in exactly one
 * place. Batched even for a single tenant (`enrichOne` delegates to `enrichMany`), the
 * identical reasoning `UnitEnrichmentService` already documents.
 */
@Injectable()
export class TenantEnrichmentService {
  constructor(@Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort) {}

  async enrichMany(tenantList: Tenant[]): Promise<EnrichedTenant[]> {
    if (tenantList.length === 0) return [];

    const tenantIds = tenantList.map((tenant) => tenant.id);
    const managerIds = [...new Set(tenantList.map((tenant) => tenant.responsibleManagerId).filter((id): id is string => id !== null))];

    const [clinicSummaries, operatorSummaries, managerSummaries] = await Promise.all([
      this.tenants.summarizeClinics(tenantIds),
      this.tenants.summarizeOperators(tenantIds),
      this.tenants.summarizeResponsibleManagers(managerIds),
    ]);

    return tenantList.map((tenant) => ({
      tenant,
      equipmentCount: clinicSummaries[tenant.id]?.equipmentCount ?? 0,
      unitCount: clinicSummaries[tenant.id]?.unitCount ?? 0,
      modalities: clinicSummaries[tenant.id]?.modalities ?? [],
      activeAgreementCount: operatorSummaries[tenant.id]?.activeAgreementCount ?? 0,
      userCount: operatorSummaries[tenant.id]?.userCount ?? 0,
      responsibleManager: tenant.responsibleManagerId ? managerSummaries[tenant.responsibleManagerId] ?? null : null,
    }));
  }

  async enrichOne(tenant: Tenant): Promise<EnrichedTenant> {
    const [enriched] = await this.enrichMany([tenant]);
    return enriched!;
  }
}
