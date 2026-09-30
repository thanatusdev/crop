import type { ExamModality, MouseMode, TargetOs } from "@crop/shared";

/**
 * The equipment to register. A single object rather than the positional constructor
 * parameters this command used to take: the clinical-identity and DICOM fields brought it
 * from 13 parameters to 22, at which point every call site becomes an unreadable column of
 * bare values and two same-typed neighbours (say `brand` and `model`, or `aeTitle` and
 * `dicomIp`) can be silently transposed with nothing -- not the compiler, not a test --
 * noticing. Named properties make that class of mistake impossible instead of unlikely.
 */
export interface NewEquipment {
  name: string;
  // `null`/omitted means "let CreateEquipmentHandler pick" -- it resolves to the tenant's
  // oldest Unit, creating a default "Unidade Principal" on the fly if the tenant has none
  // yet. A caller can also pass a specific unit id explicitly; the handler still verifies it
  // belongs to the acting tenant either way.
  unitId: string | null;
  // Clinical identity -- required, which is the whole point: the database columns are
  // nullable for rows that predate the registration screen, and this type is what keeps
  // anything new from joining them. See the equipment_clinical_identity migration.
  modality: ExamModality;
  brand: string;
  model: string;
  serialNumber: string;
  roomLabel: string;
  installedAt: Date;
  // DICOM node identity -- optional, because this platform has no DICOM integration that
  // could need them (see schema.prisma's comment on those columns).
  aeTitle: string | null;
  dicomIp: string | null;
  dicomPort: number | null;
  // Teleoperation console.
  pikvmHost: string;
  pikvmUser: string;
  pikvmPassword: string;
  pikvmTotpSecret: string | null;
  targetOs: TargetOs;
  keymap: string;
  mouseMode: MouseMode;
  screenWidth: number;
  screenHeight: number;
  cameraUrl: string | null;
}

export class CreateEquipmentCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly equipment: NewEquipment
  ) {}
}
