import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { computeAuditHash, type VerifyChainResultDto } from "@crop/shared";
import { AUDIT_REPOSITORY, type AuditRepositoryPort } from "../../ports/audit-repository.port.js";
import { VerifyAuditChainQuery } from "./verify-audit-chain.query.js";

/**
 * Recomputes every row's hash from its stored payload and compares it against the stored
 * hash, walking the chain in sequence order. This is the exact operation demoed on stage:
 * it passes on an untouched history and fails, loudly, the moment any row's payload is
 * edited directly in the database after the fact.
 */
@QueryHandler(VerifyAuditChainQuery)
export class VerifyAuditChainHandler implements IQueryHandler<VerifyAuditChainQuery, VerifyChainResultDto> {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepositoryPort) {}

  async execute(query: VerifyAuditChainQuery): Promise<VerifyChainResultDto> {
    const chain = await this.repository.loadChain(query.tenantId);

    for (const row of chain) {
      const recomputed = await computeAuditHash(row.input);
      if (recomputed !== row.hash) {
        return { valid: false, checkedRows: chain.length, brokenAtSeq: row.input.seq };
      }
    }

    return { valid: true, checkedRows: chain.length, brokenAtSeq: null };
  }
}
