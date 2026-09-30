import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { Session } from "../../../domain/session.entity.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../../ports/session-repository.port.js";
import { GetSessionByQueueEntryQuery } from "./get-session-by-queue-entry.query.js";

/**
 * No tenant check here, unlike GetSessionHandler -- this is an internal cross-module lookup
 * (see GetSessionByQueueEntryQuery's own docstring), never exposed on an HTTP route. Its only
 * caller, UpdatePreparationStatusHandler, has already loaded the QueueEntry and asserted
 * `belongsToTenant` before dispatching this; a session found by that same queue entry's id is
 * necessarily for the same equipment, and therefore the same tenant, by construction.
 */
@QueryHandler(GetSessionByQueueEntryQuery)
export class GetSessionByQueueEntryHandler implements IQueryHandler<GetSessionByQueueEntryQuery, Session | null> {
  constructor(@Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort) {}

  async execute(query: GetSessionByQueueEntryQuery): Promise<Session | null> {
    return this.sessions.findByQueueEntryId(query.queueEntryId);
  }
}
