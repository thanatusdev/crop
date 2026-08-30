import { EquipmentStatus, MouseMode, TargetOs } from "@crop/shared";

export interface EquipmentProps {
  id: string;
  tenantId: string;
  name: string;
  status: EquipmentStatus;
  pikvmHost: string;
  cameraUrl: string | null;
  targetOs: TargetOs;
  keymap: string;
  mouseMode: MouseMode;
  screenWidth: number;
  screenHeight: number;
}

/**
 * Deliberately holds no PiKVM credentials: those are decrypted only inside the
 * infrastructure layer, immediately before opening a device connection, and are never
 * attached to this entity so a bug elsewhere can't accidentally serialize them into a
 * response DTO or a log line.
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

  belongsToTenant(tenantId: string): boolean {
    return this.props.tenantId === tenantId;
  }
}
