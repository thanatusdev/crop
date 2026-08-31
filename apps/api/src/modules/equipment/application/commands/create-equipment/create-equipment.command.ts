import type { MouseMode, TargetOs } from "@crop/shared";

export class CreateEquipmentCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly name: string,
    public readonly pikvmHost: string,
    public readonly pikvmUser: string,
    public readonly pikvmPassword: string,
    public readonly targetOs: TargetOs,
    public readonly keymap: string,
    public readonly mouseMode: MouseMode,
    public readonly screenWidth: number,
    public readonly screenHeight: number,
    public readonly cameraUrl: string | null,
    public readonly pikvmTotpSecret: string | null = null
  ) {}
}

