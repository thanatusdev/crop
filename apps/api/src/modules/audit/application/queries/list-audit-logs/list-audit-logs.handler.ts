import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import type { AuditLogEntryDto } from "@crop/shared";
import { AUDIT_REPOSITORY, type AuditRepositoryPort } from "../../ports/audit-repository.port.js";
import { ListAuditLogsQuery } from "./list-audit-logs.query.js";

@QueryHandler(ListAuditLogsQuery)
export class ListAuditLogsHandler implements IQueryHandler<ListAuditLogsQuery, AuditLogEntryDto[]> {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepositoryPort) {}

  async execute(query: ListAuditLogsQuery): Promise<AuditLogEntryDto[]> {
    return this.repository.list({
      tenantId: query.tenantId,
      sessionId: query.sessionId,
      userId: query.userId,
      limit: query.limit,
      offset: query.offset,
    });
  }
}
