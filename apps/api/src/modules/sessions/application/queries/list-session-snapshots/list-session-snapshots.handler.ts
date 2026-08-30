import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import {
  SESSION_SNAPSHOT_REPOSITORY,
  type SessionSnapshotRecord,
  type SessionSnapshotRepositoryPort,
} from "../../ports/session-snapshot-repository.port.js";
import { ListSessionSnapshotsQuery } from "./list-session-snapshots.query.js";

@QueryHandler(ListSessionSnapshotsQuery)
export class ListSessionSnapshotsHandler implements IQueryHandler<ListSessionSnapshotsQuery, SessionSnapshotRecord[]> {
  constructor(@Inject(SESSION_SNAPSHOT_REPOSITORY) private readonly snapshots: SessionSnapshotRepositoryPort) {}

  async execute(query: ListSessionSnapshotsQuery): Promise<SessionSnapshotRecord[]> {
    return this.snapshots.listBySession(query.sessionId);
  }
}
