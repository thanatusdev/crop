import { Injectable } from "@nestjs/common";
import { DEFAULT_MESSAGE_SHORTCUTS } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { MessageShortcut } from "../domain/message-shortcut.entity.js";
import type { CreateMessageShortcutData, MessageShortcutRepositoryPort } from "../application/ports/message-shortcut-repository.port.js";

@Injectable()
export class PrismaMessageShortcutRepository implements MessageShortcutRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateMessageShortcutData): Promise<MessageShortcut> {
    const row = await this.prisma.messageShortcut.create({
      data: {
        tenantId: data.tenantId,
        code: data.code,
        label: data.label,
        body: data.body,
        createdByUserId: data.createdByUserId ?? undefined,
      },
    });
    return this.toDomain(row);
  }

  async findByTenantAndCode(tenantId: string, code: string): Promise<MessageShortcut | null> {
    const row = await this.prisma.messageShortcut.findUnique({ where: { tenantId_code: { tenantId, code } } });
    return row ? this.toDomain(row) : null;
  }

  async listActiveByTenant(tenantId: string): Promise<MessageShortcut[]> {
    const rows = await this.prisma.messageShortcut.findMany({
      where: { tenantId, deactivatedAt: null },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async seedDefaults(tenantId: string): Promise<void> {
    await this.prisma.messageShortcut.createMany({
      data: DEFAULT_MESSAGE_SHORTCUTS.map((shortcut) => ({ tenantId, ...shortcut })),
      skipDuplicates: true,
    });
  }

  private toDomain(row: {
    id: string;
    tenantId: string;
    code: string;
    label: string;
    body: string;
    createdByUserId: string | null;
    deactivatedAt: Date | null;
    createdAt: Date;
  }): MessageShortcut {
    return new MessageShortcut({
      id: row.id,
      tenantId: row.tenantId,
      code: row.code,
      label: row.label,
      body: row.body,
      createdByUserId: row.createdByUserId,
      deactivatedAt: row.deactivatedAt,
      createdAt: row.createdAt,
    });
  }
}
