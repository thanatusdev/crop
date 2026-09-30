import { EquipmentStatus, ExamModality, MouseMode, TargetOs } from "@crop/shared";

export interface EquipmentProps {
  id: string;
  tenantId: string;
  // Nullable during the rollout -- see schema.prisma's own comment on `Equipment.unitId`.
  // `CreateEquipmentHandler` never leaves this null for a *new* row (auto-resolving to the
  // clinic's oldest unit, creating one if none exist yet); only pre-existing rows from
  // before units existed can still carry `null` here.
  unitId: string | null;
  name: string;
  status: EquipmentStatus;
  // Retired from service by an admin. Orthogonal to `status`, which is health -- see
  // schema.prisma's comment on the column for why this is not an EquipmentStatus member.
  deactivatedAt: Date | null;
  // Clinical identity. Null only for rows registered before these fields existed -- see the
  // equipment_clinical_identity migration for why they were not backfilled with invented
  // brands and serial numbers. `CreateEquipmentRequestSchema` requires all six, so nothing
  // added from now on joins that historical set.
  modality: ExamModality | null;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  roomLabel: string | null;
  installedAt: Date | null;
  // DICOM node identity: inert stored metadata, optional even for a new row. Nothing in this
  // platform opens a DICOM association -- see schema.prisma's comment on these columns.
  aeTitle: string | null;
  dicomIp: string | null;
  dicomPort: number | null;
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

  get unitId(): string | null {
    return this.props.unitId;
  }

  get name(): string {
    return this.props.name;
  }

  get status(): EquipmentStatus {
    return this.props.status;
  }

  get deactivatedAt(): Date | null {
    return this.props.deactivatedAt;
  }

  get modality(): ExamModality | null {
    return this.props.modality;
  }

  get brand(): string | null {
    return this.props.brand;
  }

  get model(): string | null {
    return this.props.model;
  }

  get serialNumber(): string | null {
    return this.props.serialNumber;
  }

  get roomLabel(): string | null {
    return this.props.roomLabel;
  }

  get installedAt(): Date | null {
    return this.props.installedAt;
  }

  get aeTitle(): string | null {
    return this.props.aeTitle;
  }

  get dicomIp(): string | null {
    return this.props.dicomIp;
  }

  get dicomPort(): number | null {
    return this.props.dicomPort;
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

  /**
   * Whether a remote-control session may be opened against this device right now.
   *
   * The deactivation half of this is not redundant with the status check. A deactivated
   * device is skipped by PiKvmHealthPoller, so its `status` freezes at whatever it was when
   * it was retired -- retire a healthy scanner and it keeps reporting `ONLINE` forever.
   * Checking status alone would therefore happily start a session against decommissioned
   * equipment. StartSessionHandler calls this predicate rather than comparing `status`
   * itself, so both conditions live in one place instead of being re-derived per call site.
   */
  isAvailableForSession(): boolean {
    return this.props.status === EquipmentStatus.ONLINE && !this.isDeactivated();
  }

  // Manually set via EnterMaintenanceHandler/ClearMaintenanceHandler, not by the health
  // poller -- PiKvmHealthPoller checks this before ever touching status itself, so a manual
  // override actually sticks instead of being silently reverted within one poll cycle.
  isInMaintenance(): boolean {
    return this.props.status === EquipmentStatus.MAINTENANCE;
  }

  // Nullable timestamp, not a boolean column -- same reasoning as Tenant.isDeactivated() and
  // User.lockedAt: doubles as a "when" for anyone reviewing why a scanner left service.
  isDeactivated(): boolean {
    return this.props.deactivatedAt !== null;
  }

  belongsToTenant(tenantId: string): boolean {
    return this.props.tenantId === tenantId;
  }
}
