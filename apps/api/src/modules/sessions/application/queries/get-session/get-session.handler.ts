import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { Session } from "../../../domain/session.entity.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../../ports/session-repository.port.js";
import { GetSessionQuery } from "./get-session.query.js";

@QueryHandler(GetSessionQuery)
export class GetSessionHandler implements IQueryHandler<GetSessionQuery, Session> {
  constructor(@Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort) {}

  async execute(query: GetSessionQuery): Promise<Session> {
    const session = await this.sessions.findById(query.sessionId);
    if (!session) throw new NotFoundError("Session", query.sessionId);
    // Multi-tenant isolation, enforced here rather than trusted to the caller -- mirrors
    // GetEquipmentHandler. Caught by an integration test before it ever reached production:
    // this query previously had no tenant check at all, leaking session metadata (operator,
    // supervisor, status) across tenants to any authenticated user who knew or guessed a
    // session UUID.
    if (session.tenantId !== query.tenantId) {
      throw new ForbiddenError("Session does not belong to your tenant");
    }
    return session;
  }
}
