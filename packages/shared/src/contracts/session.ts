import { z } from "zod";
import { SessionStatus } from "../enums.js";

export const StartSessionRequestSchema = z.object({
  equipmentId: z.string().uuid(),
  queueEntryId: z.string().uuid().optional(),
});
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;

export const SessionStateSchema = z.object({
  id: z.string().uuid(),
  equipmentId: z.string().uuid(),
  operatorId: z.string().uuid(),
  supervisorId: z.string().uuid().nullable(),
  controllerUserId: z.string().uuid(),
  status: z.nativeEnum(SessionStatus),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export const TakeoverRequestSchema = z.object({
  sessionId: z.string().uuid(),
});
export type TakeoverRequest = z.infer<typeof TakeoverRequestSchema>;

/** Server -> client push when control changes hands (initial start, or takeover). */
export const ControllerChangedEventSchema = z.object({
  sessionId: z.string().uuid(),
  controllerUserId: z.string().uuid(),
  controllerName: z.string(),
  reason: z.enum(["session_start", "takeover"]),
});
export type ControllerChangedEvent = z.infer<typeof ControllerChangedEventSchema>;

/** Server -> client latency echo, used to render the HUD's measured RTT. */
export const LatencyPongSchema = z.object({
  clientTs: z.number(),
  serverTs: z.number(),
});
export type LatencyPong = z.infer<typeof LatencyPongSchema>;

export const SessionSnapshotSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  imagePath: z.string(),
  capturedAt: z.string(),
});
export type SessionSnapshotDto = z.infer<typeof SessionSnapshotSchema>;
