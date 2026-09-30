import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { TenantEnrichmentService, type EnrichedTenant } from "../../tenant-enrichment.service.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../ports/tenant-repository.port.js";
import { ListTenantsQuery } from "./list-tenants.query.js";

@QueryHandler(ListTenantsQuery)
export class ListTenantsHandler implements IQueryHandler<ListTenantsQuery, EnrichedTenant[]> {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    private readonly enrichment: TenantEnrichmentService
  ) {}

  async execute(): Promise<EnrichedTenant[]> {
    const tenants = await this.tenants.listAll();
    return this.enrichment.enrichMany(tenants);
  }
}
