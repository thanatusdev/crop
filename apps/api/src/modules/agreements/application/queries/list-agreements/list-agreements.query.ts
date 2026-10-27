import type { AgreementStatus } from "@crop/shared";

export class ListAgreementsQuery {
  constructor(
    /** The caller's *home* tenant, not their active one: an operator admin managing contracts is
     * acting for their own company, and must see its agreements even while switched into a
     * clinic's context. `null` means every agreement on the platform -- `PLATFORM_ADMIN` only,
     * whose home tenant is party to none of them (see `AgreementsController.partyScopeOf`). */
    public readonly tenantId: string | null,
    public readonly status?: AgreementStatus
  ) {}
}
