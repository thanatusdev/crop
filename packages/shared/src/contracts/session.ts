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
  /** Denormalized display name of `operatorId`, resolved server-side via
   * `SessionParticipantNameService` -- nullable because `User.firstName`/`lastName` are
   * nullable (legacy/seed accounts). Added for the nursing lock banner ("TRAVA OPERACIONAL
   * ATIVA ... Rafael Moura"), which otherwise has no honest way to name the operator holding
   * the lock; `SessionPage` falls back to `operatorId.slice(0, 8)` when this is null. */
  operatorName: z.string().nullable(),
  /** Denormalized `User.professionalRegistration` of `operatorId` -- resolved alongside
   * `operatorName` by the same `SessionParticipantNameService` call (see its own
   * `resolveOperatorNames`). Added for the nursing screen's "Operador Remoto" card
   * ("Rafael Moura · CRBM 4289"), which otherwise has no source for the operator's own
   * registration without a `GET /users/:id` call `NURSING` cannot make. Nullable for the
   * same reason `operatorName` is: `User.professionalRegistration` itself is nullable. */
  operatorRegistration: z.string().nullable(),
  supervisorId: z.string().uuid().nullable(),
  controllerUserId: z.string().uuid(),
  status: z.nativeEnum(SessionStatus),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** The patient-queue entry this session was started against, if any -- mirrors
   * `Session.queueEntryId` server-side. Added for `SessionPage`'s "Preparo do Paciente"
   * panel, which reads `GET /queue/:id` with this to show the nurse's live preparation
   * status; previously this DTO carried every other session field but not this one. */
  queueEntryId: z.string().uuid().nullable(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export const TakeoverRequestSchema = z.object({
  sessionId: z.string().uuid(),
});
export type TakeoverRequest = z.infer<typeof TakeoverRequestSchema>;

/** Same shape as `TakeoverRequestSchema` today, kept as its own named type: the two actions
 * are conceptually distinct (see ReturnControlToOperatorHandler) even though neither needs
 * anything beyond the session id today. */
export const ReturnControlRequestSchema = z.object({
  sessionId: z.string().uuid(),
});
export type ReturnControlRequest = z.infer<typeof ReturnControlRequestSchema>;

/** Server -> client push when control changes hands (initial start, takeover, or a
 * supervisor/admin handing control back to the operator). `controllerName` used to hold the
 * raw controllerUserId/userId (a copy-paste of the id, not a name -- see
 * SessionsGateway.onTakeoverRequest/onReturnControlRequest's prior bodies); nobody on the web
 * client ever read it, so it silently shipped wrong. Now resolved through the same
 * `SessionParticipantNameService` as `SessionState.operatorName` and nullable for the same
 * reason. */
export const ControllerChangedEventSchema = z.object({
  sessionId: z.string().uuid(),
  controllerUserId: z.string().uuid(),
  controllerName: z.string().nullable(),
  reason: z.enum(["session_start", "takeover", "return_to_operator"]),
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
