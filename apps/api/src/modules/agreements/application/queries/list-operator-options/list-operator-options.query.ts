/** Backs `GET /agreements/operator-options` -- the clinic-side mirror of
 * `ListClinicOptionsQuery`. See `AgreementCounterpartyOptionSchema`'s own docstring in
 * packages/shared for why this exists instead of pointing the picker at `GET /tenants`.
 * `clinicTenantId` is always the caller's own *home* tenant (resolved by the controller the
 * same way `ProposeAgreementHandler` does), never their active one. */
export class ListOperatorOptionsQuery {
  constructor(public readonly clinicTenantId: string) {}
}
