import { describe, expect, it } from "vitest";
import { UserRole } from "../src/enums.js";
import { MeResponseSchema } from "../src/contracts/auth.js";
import { QueueTimelineEntrySchema } from "../src/contracts/queue.js";

describe("MeResponseSchema", () => {
  it("accepts a full profile", () => {
    const result = MeResponseSchema.safeParse({
      id: "8c9c5e2a-6c1b-4b8b-9b1a-1f2e3d4c5b6a",
      email: "enfermagem@alpha.crop.health",
      role: UserRole.NURSING,
      firstName: "Camila",
      lastName: "Rocha",
      professionalRegistration: "COREN-SP 148209",
      tenantId: "8c9c5e2a-6c1b-4b8b-9b1a-1f2e3d4c5b6b",
    });
    expect(result.success).toBe(true);
  });

  // Legacy/seed accounts can have null names and no registration -- see User's own comment.
  it("accepts nullable name/registration fields", () => {
    const result = MeResponseSchema.safeParse({
      id: "8c9c5e2a-6c1b-4b8b-9b1a-1f2e3d4c5b6a",
      email: "legacy@alpha.crop.health",
      role: UserRole.OPERATOR,
      firstName: null,
      lastName: null,
      professionalRegistration: null,
      tenantId: "8c9c5e2a-6c1b-4b8b-9b1a-1f2e3d4c5b6b",
    });
    expect(result.success).toBe(true);
  });
});

describe("QueueTimelineEntrySchema", () => {
  it("accepts a resolved-name entry", () => {
    const result = QueueTimelineEntrySchema.safeParse({
      action: "PATIENT_POSITIONED",
      timestamp: "2026-09-28T11:00:00.000Z",
      actorName: "Camila Rocha",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null actorName", () => {
    expect(QueueTimelineEntrySchema.safeParse({ action: "QUEUE_ENTRY_UPDATED", timestamp: "2026-09-28T11:00:00.000Z", actorName: null }).success).toBe(
      true
    );
  });

  // Deliberately no seq/hash/prevHash -- see this schema's own docstring on why it's
  // narrower than AuditLogEntryDto.
  it("has no hash-chain fields", () => {
    expect(Object.keys(QueueTimelineEntrySchema.shape)).not.toContain("hash");
    expect(Object.keys(QueueTimelineEntrySchema.shape)).not.toContain("seq");
  });
});
