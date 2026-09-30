import type { EstablishmentType, ExamModality, UserRole } from "@crop/shared";

/**
 * Every field optional -- a real partial update, matching `UpdateUnitRequestSchema`'s own
 * shape exactly (see `EquipmentChanges` for the identical precedent on the equipment side).
 * No `clinicTenantId` here either, for the same reason the contract has none.
 */
export interface UnitChanges {
  name?: string;
  establishmentType?: EstablishmentType;
  technicalManagerId?: string | null;
  declaredModalities?: ExamModality[];
  zipCode?: string;
  street?: string;
  number?: string;
  complement?: string | null;
  district?: string;
  city?: string;
  state?: string;
  cnesCode?: string | null;
  phone?: string | null;
  technicalEmail?: string | null;
}

export class UpdateUnitCommand {
  constructor(
    public readonly unitId: string,
    public readonly actor: { userId: string; tenantId: string; role: UserRole },
    public readonly changes: UnitChanges
  ) {}
}
