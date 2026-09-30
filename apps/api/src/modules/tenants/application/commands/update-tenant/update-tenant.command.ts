export interface TenantChanges {
  name?: string;
  institutionalEmail?: string;
  phone?: string;
  zipCode?: string;
  street?: string;
  number?: string;
  complement?: string | null;
  district?: string;
  city?: string;
  state?: string;
  responsibleManagerId?: string | null;
}

export class UpdateTenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingAdminId: string,
    public readonly changes: TenantChanges
  ) {}
}
