/**
 * Backs `GET /agreements/:id/scope-options` -- the equipment picker behind the scope modal.
 *
 * `actor` is the full claims, not just a tenant id: the handler must run `assertScopeCanBeSetBy`
 * (clinic-only, same rule `SetAgreementScopeHandler` enforces), which needs the actor's *home*
 * tenant exactly the way that handler resolves it.
 */
export class ListScopeOptionsQuery {
  constructor(
    public readonly agreementId: string,
    public readonly actorTenantId: string
  ) {}
}
