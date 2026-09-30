import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import type { MeResponse } from "@crop/shared";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { GetMeQuery } from "./get-me.query.js";

@QueryHandler(GetMeQuery)
export class GetMeHandler implements IQueryHandler<GetMeQuery, MeResponse> {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort) {}

  async execute(query: GetMeQuery): Promise<MeResponse> {
    const user = await this.users.findById(query.userId);
    // In practice never happens -- a valid access token's `sub` names a real user, and this
    // codebase never hard-deletes one (see docs/architecture.md) -- but the query layer
    // still has to answer *something* if it somehow did, rather than return a null-shaped
    // 200.
    if (!user) throw new NotFoundError("User", query.userId);

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      professionalRegistration: user.professionalRegistration,
      tenantId: user.tenantId,
    };
  }
}
