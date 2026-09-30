import { AgreementStatus, type OperatorAgreementDto } from "@crop/shared";

/**
 * Display helpers for agreements, extracted from `AgreementsPage` for the same reason
 * `queue-display.ts` and `equipment-display.ts` exist: the `Record<Enum, LiteralUnionKey>` maps below
 * make `tsc` enforce that every status has a label and that every label key really exists in the
 * i18n namespace. A template literal (`` t(`agreements:status_${status}`) ``) would type-check while
 * silently rendering a missing key.
 */
type AgreementLabelKey =
  | "agreements:statusPending"
  | "agreements:statusActive"
  | "agreements:statusRejected"
  | "agreements:statusRevoked";

const STATUS_LABEL_KEYS: Record<AgreementStatus, AgreementLabelKey> = {
  [AgreementStatus.PENDING]: "agreements:statusPending",
  [AgreementStatus.ACTIVE]: "agreements:statusActive",
  [AgreementStatus.REJECTED]: "agreements:statusRejected",
  [AgreementStatus.REVOKED]: "agreements:statusRevoked",
};

export function agreementStatusLabelKeyOf(status: AgreementStatus): AgreementLabelKey {
  return STATUS_LABEL_KEYS[status];
}

/**
 * Reuses the existing `.badge` modifiers rather than adding four more: an agreement's states map
 * cleanly onto the equipment/queue vocabulary this stylesheet already carries measured AA contrast
 * for -- ACTIVE reads like `online`, PENDING like `degraded` (awaiting something), and the two
 * terminal states like `inactive`.
 */
const STATUS_BADGE_CLASSES: Record<AgreementStatus, string> = {
  [AgreementStatus.PENDING]: "degraded",
  [AgreementStatus.ACTIVE]: "online",
  [AgreementStatus.REJECTED]: "inactive",
  [AgreementStatus.REVOKED]: "offline",
};

export function agreementStatusBadgeClassOf(status: AgreementStatus): string {
  return STATUS_BADGE_CLASSES[status];
}

/** The other party's name, from the viewer's point of view. */
export function counterpartyOf(agreement: OperatorAgreementDto, viewerIsOperatorSide: boolean): string {
  return viewerIsOperatorSide ? agreement.clinicName : agreement.operatorName;
}

/**
 * Whether `tenantId` is the side that must answer this agreement -- i.e. it is PENDING and they are
 * *not* the proposer.
 *
 * Mirrors `OperatorAgreement.assertCanBeRespondedToBy` on the server, deliberately: the button only
 * renders when the request behind it would actually succeed. Showing Accept to the proposer would
 * offer an action the API refuses by design, which is the same mistake `SessionPage`'s "End session"
 * button already documents having made once.
 */
export function isActionableBy(agreement: OperatorAgreementDto, tenantId: string): boolean {
  return agreement.status === AgreementStatus.PENDING && agreement.proposedByTenantId !== tenantId;
}
