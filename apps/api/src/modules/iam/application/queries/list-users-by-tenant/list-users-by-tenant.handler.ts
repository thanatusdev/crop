import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { User } from "../../../domain/user.entity.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { ListUsersByTenantQuery } from "./list-users-by-tenant.query.js";

@QueryHandler(ListUsersByTenantQuery)
export class ListUsersByTenantHandler implements IQueryHandler<ListUsersByTenantQuery, User[]> {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort) {}

  async execute(query: ListUsersByTenantQuery): Promise<User[]> {
    return this.users.findByTenant(query.tenantId);
  }
}
