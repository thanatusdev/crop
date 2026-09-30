import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatAttachmentStoragePort } from "../application/ports/chat-attachment-storage.port.js";

/**
 * Local disk, not object storage -- see `ChatAttachmentStoragePort`'s own docstring, and
 * `SnapshotStorageService`'s near-identical shape (this is deliberately its twin, not a
 * reinvention). `read()`'s `relativePath` argument is never taken directly from a URL or user
 * input, for the same reason that file's docstring gives: the presentation layer always looks
 * up an `ExamMessage` row by its own id first and passes *that row's* `attachmentPath` here
 * (see `ChatController`'s attachment-download endpoint) -- there is no path-traversal surface,
 * since the only paths ever read here are ones `save()` itself produced.
 */
@Injectable()
export class ChatAttachmentStorageService implements ChatAttachmentStoragePort {
  private readonly rootDir: string;

  constructor(config: ConfigService) {
    this.rootDir = resolve(config.get<string>("CHAT_ATTACHMENT_STORAGE_DIR", "./storage/chat-attachments"));
  }

  async save(equipmentId: string, filename: string, data: Buffer): Promise<string> {
    const dir = join(this.rootDir, equipmentId);
    await mkdir(dir, { recursive: true });

    // A random name, not the uploaded filename -- the original name is kept separately on
    // the ExamMessage row (attachmentFilename) purely for display; using it as the actual
    // on-disk name would both collide across uploads and re-introduce the path-traversal
    // surface this file's own docstring says does not exist (an attacker-chosen filename
    // containing "../" would otherwise reach mkdir/writeFile directly).
    const storedName = `${randomUUID()}${extname(filename)}`;
    await writeFile(join(dir, storedName), data);

    return join(equipmentId, storedName);
  }

  async read(relativePath: string): Promise<Buffer> {
    return readFile(join(this.rootDir, relativePath));
  }
}
