import { z } from "zod";
import { AllergyStatus, PatientSex, PreparationStatus, QueueStatus } from "../enums.js";

/** `YYYY-MM-DD`, always interpreted as a calendar day in the clinic's configured timezone
 * (see `clinic-day.ts`) -- the shape of `GET /queue`'s optional `date` query param. */
export const ClinicDayStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

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

/**
 * `NOT_STARTED` is deliberately excluded: it is only ever the value a fresh `QueueEntry` is
 * created with, never something the nurse's quick-action buttons transition *to* -- see
 * `QueueEntry.assertCanTransitionPreparationTo` (there is no state that legally moves back
 * to it). Accepting it here would let a caller "un-position" a patient, which the UI never
 * offers and the domain never allows.
 */
export const UpdatePreparationStatusRequestSchema = z.object({
  status: z.enum([PreparationStatus.POSITIONED, PreparationStatus.INJECTED, PreparationStatus.RELEASED]),
});
export type UpdatePreparationStatusRequest = z.infer<typeof UpdatePreparationStatusRequestSchema>;

export const QueueEntrySchema = z.object({
  id: z.string().uuid(),
  equipmentId: z.string().uuid(),
  patientFirstName: z.string(),
  position: z.number().int(),
  status: z.nativeEnum(QueueStatus),
  scheduledAt: z.string().nullable(),
  preparationStatus: z.nativeEnum(PreparationStatus),
  positionedAt: z.string().nullable(),
  injectedAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
  // The nurse's editable "exam details" (see the queue-reorder/exam-details feature) --
  // deliberately not a Patient record: this is still exactly one row, on the same
  // QueueEntry, with the same first-name-only PHI posture the rest of this module already
  // established.
  examDescription: z.string().nullable(),
  contrastRequired: z.boolean(),
  patientSex: z.nativeEnum(PatientSex).nullable(),
  patientWeightKg: z.number().int().nullable(),
  preparationNotes: z.string().nullable(),
  // The nurse's structured "Questionário de Segurança & Contraste" -- three pre-procedure
  // facts recorded and displayed as-is, never interpreted into a clinical decision (the one
  // derived state anywhere in this feature is the client-side "ALERTA JEJUM" card chip,
  // computed from fastingConfirmed alone). contrastVolumeMl is the nurse's own recorded
  // dose from the exam's protocol, not a computed one -- see this feature's own
  // architecture note on why a mL figure is never derived from patientWeightKg here.
  fastingConfirmed: z.boolean(),
  fastingHours: z.number().int().nullable(),
  creatinineMgDl: z.number().nullable(),
  allergyStatus: z.nativeEnum(AllergyStatus).nullable(),
  allergyNotes: z.string().nullable(),
  contrastVolumeMl: z.number().int().nullable(),
  // Attribution for the exam-detail form's own fields (the block above plus
  // examDescription/contrastRequired/patientSex/patientWeightKg/preparationNotes) --
  // "Registrado às HH:mm por <nome>". Both null until the first PATCH /queue/:id ever
  // lands; detailsUpdatedByName is resolved server-side the same way
  // SessionState.operatorName is, never a raw user id.
  detailsUpdatedAt: z.string().nullable(),
  detailsUpdatedByName: z.string().nullable(),
  // The remote operator's own procedural note ("contrast administered, no signs of
  // extravasation") -- a genuinely separate field from `preparationNotes` above, which is the
  // *nurse's* pre-procedure note and is authorized/audited under her own exam-details write.
  // Deliberately its own column, own command, and own narrower `@Roles` (operator-side roles
  // only, see UpdateTeleoperationNotesHandler) rather than folded into
  // `UpdateQueueEntryDetailsRequestSchema`: that endpoint's whole authorization boundary is
  // "the nurse edits her own fields", and adding one operator-writable field to it would
  // either let an operator write the nurse's fields too or need a second, field-level
  // permission check bolted onto an endpoint whose simplicity is that it doesn't have one.
  teleoperationNotes: z.string().nullable(),
});
export type QueueEntryDto = z.infer<typeof QueueEntrySchema>;

/**
 * The nurse's drag/arrow "Confirmar Nova Sequência" commit -- a full explicit ordering of
 * the room's WAITING entries, not a single move-to-index operation. Chosen over
 * `{ queueEntryId, newPosition }` for three reasons: it's idempotent (resending the same
 * confirm twice is a no-op, not a double-move), it matches what the UI actually accumulates
 * while the nurse drags/arrows several cards before confirming once, and it lets the server
 * validate the *whole* proposed order against the *whole* current WAITING set in one
 * atomic check (see ReorderQueueHandler) instead of trusting a sequence of individual moves
 * that could each be individually valid but collectively stale.
 */
export const ReorderQueueRequestSchema = z
  .object({
    equipmentId: z.string().uuid(),
    // At least 2: reordering a single-entry (or empty) queue is a no-op the UI never offers
    // a "Confirmar Nova Sequência" button for in the first place.
    orderedIds: z.array(z.string().uuid()).min(2),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.orderedIds).size !== value.orderedIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["orderedIds"], message: "orderedIds must not contain duplicates" });
    }
  });
export type ReorderQueueRequest = z.infer<typeof ReorderQueueRequestSchema>;

/**
 * The nurse's "Salvar Alterações deste Paciente" form. Every field is `nullish` (optional
 * key *or* explicit `null`), the same "undefined = leave alone, null = clear" convention
 * `UpdateEquipmentRequestSchema` already uses -- a nurse clearing a previously-set weight or
 * note back out is a real, intentional action, not an omission. The `superRefine` rejects a
 * genuinely empty patch: without it, a no-op PATCH would still write a
 * `QUEUE_ENTRY_UPDATED` audit row with an empty `changedFields`, which documents nothing.
 */
export const UpdateQueueEntryDetailsRequestSchema = z
  .object({
    examDescription: z.string().trim().min(1).max(200).nullish(),
    contrastRequired: z.boolean().optional(),
    patientSex: z.nativeEnum(PatientSex).nullish(),
    patientWeightKg: z.number().int().min(1).max(500).nullish(),
    scheduledAt: z.string().datetime().nullish(),
    preparationNotes: z.string().trim().max(2000).nullish(),
    fastingConfirmed: z.boolean().optional(),
    fastingHours: z.number().int().min(0).max(72).nullish(),
    // A lab value, recorded and displayed only -- never used in any arithmetic here (see
    // this feature's own note on why creatinine stays a plain Float rather than a Decimal:
    // this repo has no Decimal type anywhere yet, and one display-only field doesn't
    // justify introducing one).
    creatinineMgDl: z.number().min(0).max(20).nullish(),
    allergyStatus: z.nativeEnum(AllergyStatus).nullish(),
    allergyNotes: z.string().trim().max(500).nullish(),
    contrastVolumeMl: z.number().int().min(0).max(500).nullish(),
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "At least one field must be provided" });
    }
  });
export type UpdateQueueEntryDetailsRequest = z.infer<typeof UpdateQueueEntryDetailsRequestSchema>;

/** Server -> client push when the nurse advances a patient's preparation status (see
 * PreparationStatus). Broadcast to the equipment's tenant room always, and additionally to
 * the session room when the queue entry already has one (`SessionPage`'s live panel) --
 * see SessionsGateway.broadcastPatientPreparationUpdated. */
export const PatientPreparationUpdatedEventSchema = z.object({
  queueEntryId: z.string().uuid(),
  equipmentId: z.string().uuid(),
  preparationStatus: z.nativeEnum(PreparationStatus),
  positionedAt: z.string().nullable(),
  injectedAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
});
export type PatientPreparationUpdatedEvent = z.infer<typeof PatientPreparationUpdatedEventSchema>;

/**
 * `GET /queue/:id/timeline` -- the nursing screen's per-exam activity panel. Deliberately
 * its own narrower shape, not `AuditLogEntryDto`: this route hands a resource-scoped slice
 * of the audit trail to a role (`NURSING`) that has no access to `GET /audit` at all (see
 * that controller's own `@Roles`, unchanged by this feature), so it carries none of the
 * hash-chain fields (`seq`/`hash`/`prevHash`) a real audit reviewer needs but a bedside
 * timeline has no business exposing. `actorName` is resolved the same way
 * `SessionState.operatorName` already is -- never a raw user id.
 *
 * Does not include `QUEUE_REORDERED` rows: those are audited under the *equipment's* id
 * (a room-level act -- see that feature's own docstring), not this one queue entry's, so a
 * per-patient timeline naturally never has occasion to carry one. Documented, not a gap.
 */
export const QueueTimelineEntrySchema = z.object({
  action: z.string(),
  timestamp: z.string(),
  actorName: z.string().nullable(),
});
export type QueueTimelineEntry = z.infer<typeof QueueTimelineEntrySchema>;

/** `PATCH /queue/:id/teleoperation-notes` -- the remote operator's own note on the exam,
 * separate from the nurse's `preparationNotes` (see `QueueEntrySchema.teleoperationNotes`'s
 * own docstring for why). A single required field, not `nullish`-and-patchable like
 * `UpdateQueueEntryDetailsRequestSchema`: there is nothing else on this narrower endpoint to
 * patch selectively, and clearing the note back to empty is just sending `""`. */
export const UpdateTeleoperationNotesRequestSchema = z.object({
  teleoperationNotes: z.string().trim().max(2000),
});
export type UpdateTeleoperationNotesRequest = z.infer<typeof UpdateTeleoperationNotesRequestSchema>;
