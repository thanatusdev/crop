import type { AgreementStatus, OperatorAgreementDto } from "@crop/shared";
import type { OperatorAgreement } from "../../access/domain/operator-agreement.entity.js";
import type { AgreementRepositoryPort, ResolvedScopeTarget } from "../../access/application/ports/agreement-repository.port.js";

/**
 * Maps one agreement to its DTO, resolving tenant names and scope labels.
 *
 * Both denormalizations exist for the same reason `UnitDto.technicalManager` carries a name rather
 * than an id: an agreement screen's whole job is to say *who* may reach *what*, and a UI that had to
 * issue one lookup per party and per scope row to render that would be both slow and unable to show
 * anything useful when a lookup failed.
 */
export function toAgreementDto(
  agreement: OperatorAgreement,
  tenantNames: Record<string, string>,
  scopes: ResolvedScopeTarget[]
): OperatorAgreementDto {
  return {
    id: agreement.id,
    clinicTenantId: agreement.clinicTenantId,
    // A name that cannot be resolved falls back to the id rather than an empty string -- the same
    // graceful degradation AdminEquipmentPage already applies to an unknown unit name.
    clinicName: tenantNames[agreement.clinicTenantId] ?? agreement.clinicTenantId,
    operatorTenantId: agreement.operatorTenantId,
    operatorName: tenantNames[agreement.operatorTenantId] ?? agreement.operatorTenantId,
    status: agreement.status as AgreementStatus,
    proposedByTenantId: agreement.proposedByTenantId,
    proposedByUserId: agreement.proposedByUserId,
    respondedByUserId: agreement.respondedByUserId,
    respondedAt: agreement.respondedAt?.toISOString() ?? null,
    revokedByUserId: agreement.revokedByUserId,
    revokedAt: agreement.revokedAt?.toISOString() ?? null,
    createdAt: agreement.createdAt.toISOString(),
    updatedAt: agreement.updatedAt.toISOString(),
    scopes: scopes.map((scope) => ({
      id: scope.id,
      unitId: scope.unitId,
      equipmentId: scope.equipmentId,
      label: scope.label,
      modality: (scope.modality as OperatorAgreementDto["scopes"][number]["modality"]) ?? null,
    })),
  };
}

/** Batches the two lookups `toAgreementDto` needs across a whole list, so a page of N agreements
 * costs one tenant-name query plus one scope query per agreement rather than 2N. */
export async function toAgreementDtos(
  agreements: OperatorAgreement[],
  repo: AgreementRepositoryPort
): Promise<OperatorAgreementDto[]> {
  const names = await repo.tenantNames(agreements.flatMap((a) => [a.clinicTenantId, a.operatorTenantId]));
  return Promise.all(
    agreements.map(async (agreement) => toAgreementDto(agreement, names, await repo.resolveScopeTargets(agreement.id)))
  );
}
