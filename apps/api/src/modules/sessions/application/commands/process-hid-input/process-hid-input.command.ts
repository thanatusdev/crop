import type { HidInputEvent, TargetOs } from "@crop/shared";

export class ProcessHidInputCommand {
  constructor(
    public readonly sessionId: string,
    public readonly tenantId: string,
    public readonly equipmentId: string,
    public readonly userId: string,
    public readonly clientOs: TargetOs,
    public readonly targetOs: TargetOs,
    public readonly event: HidInputEvent
  ) {}
}
