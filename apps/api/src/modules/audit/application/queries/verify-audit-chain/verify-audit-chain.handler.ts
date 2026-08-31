import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { verifyAuditChain, type VerifyChainResultDto } from "@crop/shared";
import { AUDIT_REPOSITORY, type AuditRepositoryPort } from "../../ports/audit-repository.port.js";
import { VerifyAuditChainQuery } from "./verify-audit-chain.query.js";

/**
 * Recomputes every row's hash from its stored payload and compares it against the stored
 * hash, walking the chain in sequence order. This is the exact operation demoed on stage:
 * it passes on an untouched history and fails, loudly, the moment any row's payload is
 * edited directly in the database after the fact. Delegates the actual walk to
 * `verifyAuditChain` (also used by `packages/shared/tests/hash-chain.test.ts`) instead of
 * reimplementing the same loop by hand -- the two used to disagree structurally (this
 * handler builds its result around the real `seq` column; the shared helper returns an
 * array *index*), reconciled by looking the broken row's `seq` up rather than assuming
 * they're the same number.
 */
@QueryHandler(VerifyAuditChainQuery)
export class VerifyAuditChainHandler implements IQueryHandler<VerifyAuditChainQuery, VerifyChainResultDto> {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepositoryPort) {}

  async execute(query: VerifyAuditChainQuery): Promise<VerifyChainResultDto> {
    const chain = await this.repository.loadChain(query.tenantId);
    const result = await verifyAuditChain(
      chain.map((row) => row.input),
      chain.map((row) => row.hash)
    );

    return {
      valid: result.valid,
      checkedRows: chain.length,
      brokenAtSeq: result.brokenAtIndex !== null ? chain[result.brokenAtIndex]!.input.seq : null,
    };
  }
}

