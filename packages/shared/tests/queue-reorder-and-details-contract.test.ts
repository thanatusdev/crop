import { describe, expect, it } from "vitest";
import { AllergyStatus, PatientSex } from "../src/enums.js";
import { ReorderQueueRequestSchema, UpdateQueueEntryDetailsRequestSchema } from "../src/contracts/queue.js";

const EQUIPMENT_ID = "8c9c5e2a-6c1b-4b8b-9b1a-1f2e3d4c5b6b";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

describe("ReorderQueueRequestSchema", () => {
  it("accepts a valid full ordering", () => {
    const result = ReorderQueueRequestSchema.safeParse({ equipmentId: EQUIPMENT_ID, orderedIds: [ID_B, ID_A, ID_C] });
    expect(result.success).toBe(true);
  });

  // A single-entry (or empty) "reorder" is a no-op the UI never offers a confirm button
  // for -- see the schema's own docstring.
  it("rejects fewer than 2 ids", () => {
    expect(ReorderQueueRequestSchema.safeParse({ equipmentId: EQUIPMENT_ID, orderedIds: [ID_A] }).success).toBe(false);
    expect(ReorderQueueRequestSchema.safeParse({ equipmentId: EQUIPMENT_ID, orderedIds: [] }).success).toBe(false);
  });

  it("rejects duplicate ids", () => {
    const result = ReorderQueueRequestSchema.safeParse({ equipmentId: EQUIPMENT_ID, orderedIds: [ID_A, ID_B, ID_A] });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid entry", () => {
    const result = ReorderQueueRequestSchema.safeParse({ equipmentId: EQUIPMENT_ID, orderedIds: [ID_A, "not-a-uuid"] });
    expect(result.success).toBe(false);
  });
});

describe("UpdateQueueEntryDetailsRequestSchema", () => {
  it("accepts a single-field patch", () => {
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ preparationNotes: "Jejum confirmado" }).success).toBe(true);
  });

  it("accepts every field together", () => {
    const result = UpdateQueueEntryDetailsRequestSchema.safeParse({
      examDescription: "TC Tórax c/ Contraste",
      contrastRequired: true,
      patientSex: PatientSex.FEMALE,
      patientWeightKg: 65,
      scheduledAt: "2026-09-28T08:00:00.000Z",
      preparationNotes: "Acesso venoso pérvio.",
    });
    expect(result.success).toBe(true);
  });

  // Undefined = leave alone, explicit null = clear -- a nurse clearing a previously-set
  // weight/note is a real action, not an omission.
  it("accepts an explicit null to clear a field", () => {
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ patientWeightKg: null }).success).toBe(true);
  });

  // Without this, a no-op PATCH would still write a QUEUE_ENTRY_UPDATED audit row with an
  // empty changedFields list.
  it("rejects an empty patch", () => {
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an out-of-range weight", () => {
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ patientWeightKg: 0 }).success).toBe(false);
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ patientWeightKg: 501 }).success).toBe(false);
  });

  it("rejects notes over 2000 characters", () => {
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ preparationNotes: "a".repeat(2001) }).success).toBe(false);
  });

  it("rejects an unknown patientSex", () => {
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ patientSex: "UNKNOWN" }).success).toBe(false);
  });

  // The "Questionário de Segurança & Contraste" fields -- recorded and displayed, never
  // interpreted (see AllergyStatus's own docstring).
  it("accepts the safety-questionnaire fields together", () => {
    const result = UpdateQueueEntryDetailsRequestSchema.safeParse({
      fastingConfirmed: true,
      fastingHours: 6,
      creatinineMgDl: 0.9,
      allergyStatus: AllergyStatus.NEGATED,
      allergyNotes: null,
      contrastVolumeMl: 102,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an out-of-range fastingHours/creatinineMgDl/contrastVolumeMl", () => {
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ fastingHours: 73 }).success).toBe(false);
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ fastingHours: -1 }).success).toBe(false);
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ creatinineMgDl: 21 }).success).toBe(false);
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ creatinineMgDl: -0.1 }).success).toBe(false);
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ contrastVolumeMl: 501 }).success).toBe(false);
  });

  it("rejects an unknown allergyStatus", () => {
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ allergyStatus: "MAYBE" }).success).toBe(false);
  });

  it("rejects allergyNotes over 500 characters", () => {
    expect(UpdateQueueEntryDetailsRequestSchema.safeParse({ allergyNotes: "a".repeat(501) }).success).toBe(false);
  });
});
