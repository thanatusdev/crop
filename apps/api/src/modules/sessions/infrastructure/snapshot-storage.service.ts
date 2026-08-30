import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SnapshotStoragePort } from "../application/ports/snapshot-storage.port.js";

/**
 * Local disk, not object storage -- an explicit MVP scope decision, not an oversight. See
 * SnapshotStoragePort's docstring: swapping this for S3/GCS later only ever touches this one
 * file.
 *
 * `read()`'s `relativePath` argument is never taken directly from a URL or user input: the
 * presentation layer always looks up a `SessionSnapshot` row by its own id first and passes
 * *that row's* `imagePath` here (see SessionsController's image endpoint) -- so there is no
 * path-traversal surface, since the set of values this method is ever called with is exactly
 * the set of paths `save()` itself produced.
 */
@Injectable()
export class SnapshotStorageService implements SnapshotStoragePort {
  private readonly rootDir: string;

  constructor(config: ConfigService) {
    this.rootDir = resolve(config.get<string>("SNAPSHOT_STORAGE_DIR", "./storage/snapshots"));
  }

  async save(sessionId: string, jpeg: Buffer): Promise<string> {
    const dir = join(this.rootDir, sessionId);
    await mkdir(dir, { recursive: true });

    const filename = `${Date.now()}.jpg`;
    await writeFile(join(dir, filename), jpeg);

    return join(sessionId, filename);
  }

  async read(relativePath: string): Promise<Buffer> {
    return readFile(join(this.rootDir, relativePath));
  }
}
