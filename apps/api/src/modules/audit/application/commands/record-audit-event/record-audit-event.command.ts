import type { AuditEvent } from "../../../domain/audit-event.js";

export class RecordAuditEventCommand {
  constructor(public readonly event: AuditEvent) {}
}
