/** Backs `GET /agreements/clinic-options` -- see `ClinicAgreementOptionSchema`'s own
 * docstring in packages/shared for why this exists instead of pointing the picker at
 * `GET /tenants`. `operatorTenantId` is always the caller's own *home* tenant (resolved by
 * the controller the same way `ProposeAgreementHandler` does), never their active one. */
export class ListClinicOptionsQuery {
  constructor(public readonly operatorTenantId: string) {}
}
