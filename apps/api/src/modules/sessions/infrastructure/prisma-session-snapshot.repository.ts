import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import type {
  CreateSnapshotData,
  SessionSnapshotRecord,
  SessionSnapshotRepositoryPort,
} from "../application/ports/session-snapshot-repository.port.js";

@Injectable()
export class PrismaSessionSnapshotRepository implements SessionSnapshotRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateSnapshotData): Promise<SessionSnapshotRecord> {
    return this.prisma.sessionSnapshot.create({
      data: { sessionId: data.sessionId, imagePath: data.imagePath },
    });
  }

  async listBySession(sessionId: string): Promise<SessionSnapshotRecord[]> {
    return this.prisma.sessionSnapshot.findMany({
      where: { sessionId },
      orderBy: { capturedAt: "asc" },
      select: { id: true, sessionId: true, imagePath: true, capturedAt: true },
    });
  }

  async findById(id: string): Promise<SessionSnapshotRecord | null> {
    return this.prisma.sessionSnapshot.findUnique({
      where: { id },
      select: { id: true, sessionId: true, imagePath: true, capturedAt: true },
    });
  }
}
