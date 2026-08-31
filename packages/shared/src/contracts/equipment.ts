import { z } from "zod";
import { EquipmentStatus, MouseMode, TargetOs } from "../enums.js";
import { DEFAULT_KEYMAP, PIKVM_KEYMAPS } from "../hid/keymaps.js";

export const EquipmentSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  status: z.nativeEnum(EquipmentStatus),
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
  cameraUrl: z.string().url().optional(),
});
export type CreateEquipmentRequest = z.infer<typeof CreateEquipmentRequestSchema>;
