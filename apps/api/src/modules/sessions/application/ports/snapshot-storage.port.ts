export const SNAPSHOT_STORAGE = Symbol("SNAPSHOT_STORAGE");

/**
 * Where snapshot JPEGs actually live. Local disk for this MVP (see
 * SnapshotStorageService) -- the Prisma schema's own comment on `SessionSnapshot.imagePath`
 * already anticipates this becoming an object-storage key instead, without any application
 * or presentation code needing to change: only this port's implementation would.
 */
export interface SnapshotStoragePort {
  /** Returns a path relative to the storage root, suitable for storing in the database. */
  save(sessionId: string, jpeg: Buffer): Promise<string>;
  read(relativePath: string): Promise<Buffer>;
}
