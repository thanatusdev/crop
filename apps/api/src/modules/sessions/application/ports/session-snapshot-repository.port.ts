export const SESSION_SNAPSHOT_REPOSITORY = Symbol("SESSION_SNAPSHOT_REPOSITORY");

export interface SessionSnapshotRecord {
  id: string;
  sessionId: string;
  imagePath: string;
  capturedAt: Date;
}

export interface CreateSnapshotData {
  sessionId: string;
  imagePath: string;
}

export interface SessionSnapshotRepositoryPort {
  create(data: CreateSnapshotData): Promise<SessionSnapshotRecord>;
  listBySession(sessionId: string): Promise<SessionSnapshotRecord[]>;
  findById(id: string): Promise<SessionSnapshotRecord | null>;
}
