/**
 * An operating company may now reach less of a clinic than it could a moment ago: its agreement
 * was revoked, or the clinic narrowed its scope.
 *
 * Lives in AccessModule, not AgreementsModule, so SessionsModule can react to it (suspending that
 * company's control of live sessions on equipment it no longer covers) without importing
 * AgreementsModule -- the same one-directional edge `OperatorAccessService` keeps. Carries the
 * pair only: the handler re-reads the agreement, so it decides from the state that was actually
 * committed rather than from a snapshot taken by whoever published.
 */
export class AgreementAccessReducedEvent {
  constructor(
    public readonly clinicTenantId: string,
    public readonly operatorTenantId: string,
    public readonly reason: "agreement_revoked" | "agreement_scope_reduced"
  ) {}
}
