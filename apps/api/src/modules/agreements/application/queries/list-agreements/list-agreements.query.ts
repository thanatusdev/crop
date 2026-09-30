import type { AgreementStatus } from "@crop/shared";

export class ListAgreementsQuery {
  constructor(
    /** The caller's *home* tenant, not their active one: an operator admin managing contracts is
     * acting for their own company, and must see its agreements even while switched into a
     * clinic's context. */
    public readonly tenantId: string,
    public readonly status?: AgreementStatus
  ) {}
}
