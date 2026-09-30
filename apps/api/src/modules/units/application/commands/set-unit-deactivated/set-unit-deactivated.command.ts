import type { UserRole } from "@crop/shared";

export class SetUnitDeactivatedCommand {
  constructor(
    public readonly unitId: string,
    public readonly actor: { userId: string; tenantId: string; role: UserRole },
    /** `true` takes the unit out of service; `false` returns it. */
    public readonly deactivated: boolean
  ) {}
}
