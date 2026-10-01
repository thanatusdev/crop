import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { QueueDocumentStoragePort } from "../application/ports/queue-document-storage.port.js";

/**
 * The nurse's uploaded exam-order documents (pedido médico / laudo anterior) -- a near-exact
 * mirror of `ChatAttachmentStorageService`: local disk, keyed by the owning resource's id
 * (here `queueEntryId` rather than `equipmentId`), a random on-disk name so neither a
 * path-traversal attempt nor a collision between two uploads can reach `writeFile` through
 * an attacker- or coincidence-chosen filename. The original name is kept separately on the
 * `QueueEntryDocument` row (`filename`) purely for display.
 *
 * Writes under this directory survive a redeploy as long as the volume documented in
 * DEPLOY.md stays mounted at the path `QUEUE_DOCUMENT_STORAGE_DIR` resolves under -- see that
 * file's "Known limitations" section.
 */
@Injectable()
export class QueueDocumentStorageService implements QueueDocumentStoragePort {
  private readonly rootDir: string;

  constructor(config: ConfigService) {
    this.rootDir = resolve(config.get<string>("QUEUE_DOCUMENT_STORAGE_DIR", "./storage/queue-documents"));
  }

  async save(queueEntryId: string, filename: string, data: Buffer): Promise<string> {
    const dir = join(this.rootDir, queueEntryId);
    await mkdir(dir, { recursive: true });

    const storedName = `${randomUUID()}${extname(filename)}`;
    await writeFile(join(dir, storedName), data);

    return join(queueEntryId, storedName);
  }

  async read(relativePath: string): Promise<Buffer> {
    return readFile(join(this.rootDir, relativePath));
  }

  /** `force: true` -- removal is still correct (nothing left to serve) even if the file was
   * somehow already gone, which matters here specifically because `RemoveQueueDocumentHandler`
   * deletes the DB row first (see that port's own docstring on the ordering) and must not
   * leave the operation half-done if this second step hits a file that's already missing. */
  async delete(relativePath: string): Promise<void> {
    await rm(join(this.rootDir, relativePath), { force: true });
  }
}
