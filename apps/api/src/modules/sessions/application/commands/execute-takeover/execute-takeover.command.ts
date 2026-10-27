import { UserRole } from "@crop/shared";

export class ExecuteTakeoverCommand {
  constructor(
    public readonly sessionId: string,
    public readonly tenantId: string,
    public readonly supervisorId: string,
    public readonly supervisorRole: UserRole,
    /** The caller's own organisation (`AccessTokenClaims.homeTenantId`). Differs from `tenantId`
     * for an operating company's supervisor switched into the clinic -- which is exactly who
     * must not take control back once that company's control has been suspended. */
    public readonly supervisorHomeTenantId?: string
  ) {}
}
