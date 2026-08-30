import { z } from "zod";
import { QueueStatus } from "../enums.js";

export const CreateQueueEntryRequestSchema = z.object({
  equipmentId: z.string().uuid(),
  patientFirstName: z.string().min(1),
  scheduledAt: z.string().datetime().optional(),
});
export type CreateQueueEntryRequest = z.infer<typeof CreateQueueEntryRequestSchema>;

export const UpdateQueueStatusRequestSchema = z.object({
  status: z.nativeEnum(QueueStatus),
});
export type UpdateQueueStatusRequest = z.infer<typeof UpdateQueueStatusRequestSchema>;

export const QueueEntrySchema = z.object({
  id: z.string().uuid(),
  equipmentId: z.string().uuid(),
  patientFirstName: z.string(),
  position: z.number().int(),
  status: z.nativeEnum(QueueStatus),
  scheduledAt: z.string().nullable(),
});
export type QueueEntryDto = z.infer<typeof QueueEntrySchema>;
