import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { Tenant } from "../../../domain/tenant.entity.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../ports/tenant-repository.port.js";
import { ListTenantsQuery } from "./list-tenants.query.js";

@QueryHandler(ListTenantsQuery)
export class ListTenantsHandler implements IQueryHandler<ListTenantsQuery, Tenant[]> {
  constructor(@Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort) {}

  async execute(): Promise<Tenant[]> {
    return this.tenants.listAll();
  }
}
