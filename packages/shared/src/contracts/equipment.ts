import { z } from "zod";
import { EquipmentStatus, ExamModality, MouseMode, TargetOs } from "../enums.js";
import { DEFAULT_KEYMAP, PIKVM_KEYMAPS } from "../hid/keymaps.js";

/**
 * A DICOM Application Entity title. Stored metadata only -- nothing in this platform opens a
 * DICOM association (see the DICOM block's comment in schema.prisma) -- but validated to the
 * real DICOM constraint anyway (PS3.5: max 16 characters, no leading/trailing space, and by
 * near-universal convention uppercase alphanumerics with `_`/`-`). Storing a value the
 * external PACS would reject outright is worse than storing nothing, and this is cheap.
 */
const AeTitleSchema = z
  .string()
  .trim()
  .max(16, "AE Title must be at most 16 characters")
  .regex(/^[A-Z0-9_-]+$/, "AE Title must use uppercase letters, digits, underscore or hyphen only");

/**
 * Accepts either a full ISO datetime or a bare `YYYY-MM-DD` (what an `<input type="date">`
 * submits), always yielding a `Date`. A bare date is anchored at UTC midnight rather than
 * local midnight: this is a calendar date -- the day a device was cleared for clinical use --
 * so it must not shift backwards a day for a user in a negative-offset timezone, which is
 * exactly what `new Date("2025-12-21")` parsed as local time would do.
 */
const CalendarDateSchema = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").transform((value) => new Date(`${value}T00:00:00.000Z`)),
  z.coerce.date(),
]);

export const EquipmentSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  // Never null for a new row (see schema.prisma's own comment) -- nullable here only
  // because pre-existing rows created before units existed could still carry it. Every
  // equipment created through CreateEquipmentHandler from now on always has a real one.
  unitId: z.string().uuid().nullable(),
  name: z.string().min(1),
  status: z.nativeEnum(EquipmentStatus),
  /**
   * Retired from service by an admin. A derived boolean, not the raw `deactivatedAt`
   * timestamp -- same reasoning as `TenantDto.deactivated`: the UI only ever branches on
   * whether, never on when.
   *
   * Deliberately separate from `status` rather than folded into it as an `INACTIVE` member:
   * `status` is device health, rewritten every 10 seconds by the health poller, so it cannot
   * also carry a lifecycle decision (see schema.prisma's comment on the column). A consumer
   * rendering a single status pill therefore has to check this field FIRST -- a deactivated
   * scanner's `status` is frozen at whatever it was when it was retired, very often `ONLINE`,
   * which is not a truthful thing to show on its own for equipment that is out of service.
   */
  deactivated: z.boolean(),

  // --- Clinical identity ---------------------------------------------------------------
  // Nullable for the same reason `unitId` is, and for rows from before the equipment
  // registration screen existed: see the migration's own note on why these were not
  // backfilled with invented values. Required on *create* from here on, so every row added
  // from now on has them -- consumers still have to handle null for the historical set.
  modality: z.nativeEnum(ExamModality).nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  serialNumber: z.string().nullable(),
  roomLabel: z.string().nullable(),
  // Serialized as an ISO string over the wire; `z.coerce.date()` accepts both that and a
  // real Date, so this same schema validates the API's own outgoing DTO and a client's
  // parse of the response it receives.
  installedAt: z.coerce.date().nullable(),

  // --- DICOM node identity (inert metadata) --------------------------------------------
  aeTitle: z.string().nullable(),
  dicomIp: z.string().nullable(),
  dicomPort: z.number().int().nullable(),

  // --- Teleoperation console -----------------------------------------------------------
  // Host/username are not secrets (an address and a login name, not a credential) --
  // deliberately included so an edit form has something to show/prefill. pikvmPassword and
  // the PiKVM TOTP secret never appear here and never will; see UpdateEquipmentRequestSchema
  // for why those stay write-only.
  pikvmHost: z.string(),
  pikvmUser: z.string(),
  targetOs: z.nativeEnum(TargetOs),
  keymap: z.string(),
  mouseMode: z.nativeEnum(MouseMode),
  screenWidth: z.number().int().positive(),
  screenHeight: z.number().int().positive(),
  cameraUrl: z.string().url().nullable(),
});
export type EquipmentDto = z.infer<typeof EquipmentSchema>;

export const CreateEquipmentRequestSchema = z.object({
  name: z.string().min(1),
  // Omitted -- not required -- means "let CreateEquipmentHandler pick": the clinic's oldest
  // unit, creating a default "Unidade Principal" if it has none yet. Passed explicitly to
  // put new equipment under a specific one instead.
  unitId: z.string().uuid().optional(),

  // --- Clinical identity ---------------------------------------------------------------
  // Required, unlike on the DTO above: the whole point of the registration screen is that a
  // device's clinical identity is known at the moment it's registered. This is where the
  // "nullable in the database, never null for a new row" promise in schema.prisma is
  // actually kept -- there is no NOT NULL constraint doing it, so if this ever loosens, the
  // null set starts growing again.
  modality: z.nativeEnum(ExamModality),
  brand: z.string().trim().min(1),
  model: z.string().trim().min(1),
  serialNumber: z.string().trim().min(1),
  roomLabel: z.string().trim().min(1),
  installedAt: CalendarDateSchema,

  // --- DICOM node identity (inert metadata) --------------------------------------------
  // Optional, unlike the clinical block above: a device can be registered and teleoperated
  // with no PACS details recorded at all, because nothing in this platform uses them.
  //
  // `.nullish()`, not `.optional()`: for a field whose whole meaning is "may have no value,"
  // an absent key and an explicit `null` are the same statement, and accepting one while
  // rejecting the other only creates a trap. It is also an asymmetry with
  // `UpdateEquipmentRequestSchema` below, which does accept `null` here -- so a form that
  // (reasonably) sends `{aeTitle: null}` for an empty input would work when editing and fail
  // when creating. The controller normalizes both to `null` before persistence.
  aeTitle: AeTitleSchema.nullish(),
  // Plain hostname-or-IP string, not `z.string().ip()`: PACS nodes are routinely addressed
  // by hostname, and rejecting one would be inventing a constraint stricter than the thing
  // this field is a note *about*.
  dicomIp: z.string().trim().min(1).nullish(),
  dicomPort: z.number().int().min(1).max(65535).nullish(),

  // --- Teleoperation console -----------------------------------------------------------
  pikvmHost: z.string().min(1),
  pikvmUser: z.string().min(1),
  pikvmPassword: z.string().min(1),
  targetOs: z.nativeEnum(TargetOs),
  // Was `z.string().default("en-us")` -- any string at all, including one PiKVM itself would
  // reject or silently mishandle. `PIKVM_KEYMAPS` (every layout PiKVM's own HTTP API
  // actually supports, see that file) existed but was never wired into any validation at
  // all until now.
  keymap: z.enum(PIKVM_KEYMAPS).default(DEFAULT_KEYMAP),
  // `MouseMode.RELATIVE` exists in the domain/DB (kept, not deleted, since removing an enum
  // value that's already in the database would be a breaking schema change), but nothing in
  // the actual input pipeline branches on it at all -- `use-hid-input.ts` on the frontend
  // always captures and sends absolute coordinates regardless of what's configured here, and
  // the WS session-join context never even threads `mouseMode` through to begin with. Rather
  // than let an admin pick an option that silently does nothing, this is restricted to the
  // one mode that's actually implemented until relative mode is built for real -- see
  // docs/architecture.md.
  mouseMode: z.literal(MouseMode.ABSOLUTE).default(MouseMode.ABSOLUTE),
  screenWidth: z.number().int().positive().default(1920),
  screenHeight: z.number().int().positive().default(1080),
  // `.nullish()` for the same reason as the DICOM fields above: an unset optional URL is
  // equally well expressed as absent or as null, and the update schema already accepts null.
  cameraUrl: z.string().url().nullish(),
});
export type CreateEquipmentRequest = z.infer<typeof CreateEquipmentRequestSchema>;

/**
 * Every field optional -- a real partial update, not "resend everything." `pikvmPassword`
 * absent or blank means "leave the stored credential unchanged," the same UX precedent as
 * AdminResetPasswordRequestSchema: nothing here ever echoes the *current* password back for
 * an admin to see, so there's no way to distinguish "unchanged" from "intentionally blank"
 * other than treating blank as unchanged, matching how every other credential-bearing form
 * in this app already behaves.
 *
 * The clinical-identity fields are `.optional()` but NOT `.nullable()`, unlike the DICOM
 * trio: an update may leave them alone, but it may not blank out the brand/model/serial of
 * a device that has them -- that would walk a row backwards into the historical-null set
 * the create schema exists to stop growing. The DICOM fields *are* nullable, because
 * "actually, this device has no PACS entry" is a legitimate correction.
 */
export const UpdateEquipmentRequestSchema = z.object({
  name: z.string().min(1).optional(),
  // `null` explicitly unassigns the unit; omitted leaves it unchanged. A non-null value
  // must belong to the equipment's own tenant -- UpdateEquipmentHandler enforces that.
  unitId: z.string().uuid().nullable().optional(),

  modality: z.nativeEnum(ExamModality).optional(),
  brand: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  serialNumber: z.string().trim().min(1).optional(),
  roomLabel: z.string().trim().min(1).optional(),
  installedAt: CalendarDateSchema.optional(),

  aeTitle: AeTitleSchema.nullable().optional(),
  dicomIp: z.string().trim().min(1).nullable().optional(),
  dicomPort: z.number().int().min(1).max(65535).nullable().optional(),

  pikvmHost: z.string().min(1).optional(),
  pikvmUser: z.string().min(1).optional(),
  pikvmPassword: z.string().min(1).optional(),
  targetOs: z.nativeEnum(TargetOs).optional(),
  keymap: z.enum(PIKVM_KEYMAPS).optional(),
  mouseMode: z.literal(MouseMode.ABSOLUTE).optional(),
  screenWidth: z.number().int().positive().optional(),
  screenHeight: z.number().int().positive().optional(),
  cameraUrl: z.string().url().nullable().optional(),
});
export type UpdateEquipmentRequest = z.infer<typeof UpdateEquipmentRequestSchema>;
