import { EquipmentStatus, MouseMode, TargetOs } from "@crop/shared";

export interface EquipmentProps {
  id: string;
  tenantId: string;
  name: string;
  status: EquipmentStatus;
  pikvmHost: string;
  pikvmUser: string;
  cameraUrl: string | null;
  targetOs: TargetOs;
  keymap: string;
  mouseMode: MouseMode;
  screenWidth: number;
  screenHeight: number;
}

/**
 * Deliberately holds no PiKVM *password/secret*: those are decrypted only inside the
 * infrastructure layer, immediately before opening a device connection, and are never
 * attached to this entity so a bug elsewhere can't accidentally serialize them into a
 * response DTO or a log line. `pikvmHost`/`pikvmUser` are not secrets (an address and a
 * login name, not a credential) and are fine to carry here and round-trip to an edit form.
 */
export class Equipment {
  constructor(private readonly props: EquipmentProps) {}

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get name(): string {
    return this.props.name;
  }

  get status(): EquipmentStatus {
    return this.props.status;
  }

  get pikvmHost(): string {
    return this.props.pikvmHost;
  }

  get pikvmUser(): string {
    return this.props.pikvmUser;
  }

  get cameraUrl(): string | null {
    return this.props.cameraUrl;
  }

  get targetOs(): TargetOs {
    return this.props.targetOs;
  }

  get keymap(): string {
    return this.props.keymap;
  }

  get mouseMode(): MouseMode {
    return this.props.mouseMode;
  }

  get screenWidth(): number {
    return this.props.screenWidth;
  }

  get screenHeight(): number {
    return this.props.screenHeight;
  }

  isAvailableForSession(): boolean {
    return this.props.status === EquipmentStatus.ONLINE;
  }

  // Manually set via EnterMaintenanceHandler/ClearMaintenanceHandler, not by the health
  // poller -- PiKvmHealthPoller checks this before ever touching status itself, so a manual
  // override actually sticks instead of being silently reverted within one poll cycle.
  isInMaintenance(): boolean {
    return this.props.status === EquipmentStatus.MAINTENANCE;
  }

  belongsToTenant(tenantId: string): boolean {
    return this.props.tenantId === tenantId;
  }
}
