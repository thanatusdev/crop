import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { User } from "../../../domain/user.entity.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { GetUserByIdQuery } from "./get-user-by-id.query.js";

@QueryHandler(GetUserByIdQuery)
export class GetUserByIdHandler implements IQueryHandler<GetUserByIdQuery, User> {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort) {}

  async execute(query: GetUserByIdQuery): Promise<User> {
    const user = await this.users.findById(query.userId);
    if (!user) throw new NotFoundError("User", query.userId);
    // Same tenant-isolation pattern as GetEquipmentHandler: enforced here, not trusted to
    // the caller, so one tenant's admin can never look up another tenant's user by UUID.
    if (!user.belongsToTenant(query.requestingTenantId)) {
      throw new ForbiddenError("User does not belong to your tenant");
    }
    return user;
  }
}

