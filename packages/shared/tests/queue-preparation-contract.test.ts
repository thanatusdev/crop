import { describe, expect, it } from "vitest";
import { PreparationStatus } from "../src/enums.js";
import {
  PatientPreparationUpdatedEventSchema,
  QueueEntrySchema,
  UpdatePreparationStatusRequestSchema,
} from "../src/contracts/queue.js";

/**
 * `PreparationStatus.NOT_STARTED` is a starting value only -- a fresh `QueueEntry` is created
 * with it, but nothing ever legally transitions *to* it (see
 * `QueueEntry.assertCanTransitionPreparationTo` in apps/api). `UpdatePreparationStatusRequest`
 * is the wire boundary that keeps a caller from ever writing it, so this is worth testing
 * directly rather than trusting the handler's domain guard to be the only thing enforcing it.
 */
describe("UpdatePreparationStatusRequestSchema -- NOT_STARTED is not a writable value", () => {
  it.each([PreparationStatus.POSITIONED, PreparationStatus.INJECTED, PreparationStatus.RELEASED])(
    "accepts %s",
    (status) => {
      expect(UpdatePreparationStatusRequestSchema.safeParse({ status }).success).toBe(true);
    }
  );

  it("rejects NOT_STARTED", () => {
    expect(UpdatePreparationStatusRequestSchema.safeParse({ status: PreparationStatus.NOT_STARTED }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(UpdatePreparationStatusRequestSchema.safeParse({ status: "DISCHARGED" }).success).toBe(false);
  });
});

const validQueueEntry = {
  id: "8c9c5e2a-6c1b-4b8b-9b1a-1f2e3d4c5b6a",
  equipmentId: "8c9c5e2a-6c1b-4b8b-9b1a-1f2e3d4c5b6b",
  patientFirstName: "João",
  position: 1,
  status: "WAITING",
  scheduledAt: null,
  preparationStatus: PreparationStatus.NOT_STARTED,
  positionedAt: null,
  injectedAt: null,
  releasedAt: null,
  examDescription: null,
  contrastRequired: false,
  patientSex: null,
  patientWeightKg: null,
  preparationNotes: null,
  fastingConfirmed: false,
  fastingHours: null,
  creatinineMgDl: null,
  allergyStatus: null,
  allergyNotes: null,
  contrastVolumeMl: null,
  detailsUpdatedAt: null,
  detailsUpdatedByName: null,
  teleoperationNotes: null,
  metforminUse: null,
  anticoagulantUse: null,
  documents: [],
};

describe("QueueEntrySchema -- preparation fields", () => {
  it("accepts a freshly-created entry (NOT_STARTED, every timestamp null)", () => {
    expect(QueueEntrySchema.safeParse(validQueueEntry).success).toBe(true);
  });

  it("accepts a positioned-then-released entry that skipped INJECTED", () => {
    const result = QueueEntrySchema.safeParse({
      ...validQueueEntry,
      preparationStatus: PreparationStatus.RELEASED,
      positionedAt: "2026-09-28T08:02:15.000Z",
      injectedAt: null,
      releasedAt: "2026-09-28T08:14:02.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing preparationStatus", () => {
    const { preparationStatus: _omitted, ...withoutField } = validQueueEntry;
    expect(QueueEntrySchema.safeParse(withoutField).success).toBe(false);
  });
});

describe("PatientPreparationUpdatedEventSchema", () => {
  it("accepts a valid push payload", () => {
    const result = PatientPreparationUpdatedEventSchema.safeParse({
      queueEntryId: validQueueEntry.id,
      equipmentId: validQueueEntry.equipmentId,
      preparationStatus: PreparationStatus.POSITIONED,
      positionedAt: "2026-09-28T08:02:15.000Z",
      injectedAt: null,
      releasedAt: null,
    });
    expect(result.success).toBe(true);
  });

  // Deliberately does NOT carry patientFirstName -- see the queue module's audit handler,
  // which never puts it in AuditEvent.details either (queue-tenant-isolation.e2e.spec.ts
  // asserts that for the audit side; this is the equivalent guard for the wire event).
  it("has no patientFirstName field", () => {
    expect(Object.keys(PatientPreparationUpdatedEventSchema.shape)).not.toContain("patientFirstName");
  });
});
