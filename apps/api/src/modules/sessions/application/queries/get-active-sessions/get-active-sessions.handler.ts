import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { Session } from "../../../domain/session.entity.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../../ports/session-repository.port.js";
import { GetActiveSessionsQuery } from "./get-active-sessions.query.js";

@QueryHandler(GetActiveSessionsQuery)
export class GetActiveSessionsHandler implements IQueryHandler<GetActiveSessionsQuery, Session[]> {
  constructor(@Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort) {}

  async execute(query: GetActiveSessionsQuery): Promise<Session[]> {
    return this.sessions.listActiveByTenant(query.tenantId);
  }
}
