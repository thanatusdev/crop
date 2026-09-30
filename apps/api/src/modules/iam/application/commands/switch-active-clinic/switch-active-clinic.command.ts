import type { TargetOs } from "@crop/shared";

export class SwitchActiveClinicCommand {
  constructor(
    public readonly userId: string,
    public readonly targetClinicTenantId: string,
    public readonly clientOs: TargetOs
  ) {}
}

export interface SwitchActiveClinicResult {
  accessToken: string;
  refreshToken: string;
}
