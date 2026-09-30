import type { UserRole } from "@crop/shared";

/** Candidates for "Gestor Técnico Local" when registering/editing a unit under this clinic. */
export class ListTechnicalManagerOptionsQuery {
  constructor(
    public readonly clinicTenantId: string,
    public readonly requestingUserId: string,
    public readonly requestingTenantId: string,
    public readonly requestingRole: UserRole
  ) {}
}
