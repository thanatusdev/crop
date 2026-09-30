import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { TenantEnrichmentService, type EnrichedTenant } from "../../tenant-enrichment.service.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../ports/tenant-repository.port.js";
import { GetTenantQuery } from "./get-tenant.query.js";

@QueryHandler(GetTenantQuery)
export class GetTenantHandler implements IQueryHandler<GetTenantQuery, EnrichedTenant> {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    private readonly enrichment: TenantEnrichmentService
  ) {}

  async execute(query: GetTenantQuery): Promise<EnrichedTenant> {
    const tenant = await this.tenants.findById(query.tenantId);
    if (!tenant) throw new NotFoundError("Tenant", query.tenantId);
    return this.enrichment.enrichOne(tenant);
  }
}
