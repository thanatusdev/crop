import { z } from "zod";
import { EquipmentStatus, MouseMode, TargetOs } from "../enums.js";

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
  keymap: z.string().default("en-us"),
  mouseMode: z.nativeEnum(MouseMode).default(MouseMode.ABSOLUTE),
  screenWidth: z.number().int().positive().default(1920),
  screenHeight: z.number().int().positive().default(1080),
  cameraUrl: z.string().url().optional(),
});
export type CreateEquipmentRequest = z.infer<typeof CreateEquipmentRequestSchema>;
