import { describe, expect, it } from "vitest";
import { ExamModality, MouseMode, TargetOs } from "../src/enums.js";
import { CreateEquipmentRequestSchema, UpdateEquipmentRequestSchema } from "../src/contracts/equipment.js";

/**
 * These schemas carry a rule the database itself does not: `equipment.modality`, `.brand`,
 * `.model`, `.serialNumber`, `.roomLabel` and `.installedAt` are all nullable columns (rows
 * predating the equipment-registration screen have no honest value for them -- see that
 * migration's own note on why they were not backfilled with invented data), so the ONLY
 * thing keeping the null set from growing with every new row is `CreateEquipmentRequestSchema`
 * requiring them. There is no NOT NULL constraint to fall back on if this loosens, which is
 * exactly why it's worth a test rather than trusting the schema to stay as written.
 */

const validCreate = {
  name: "Ressonancia 01",
  modality: ExamModality.MRI,
  brand: "Siemens",
  model: "Magnetom Vida 3.0T",
  serialNumber: "123456789",
  roomLabel: "Sala RM-01 - Pavimento Terreo",
  installedAt: "2025-12-21",
  pikvmHost: "https://10.0.1.50",
  pikvmUser: "admin",
  pikvmPassword: "s3cret",
  targetOs: TargetOs.WINDOWS,
};

describe("CreateEquipmentRequestSchema -- clinical identity is mandatory for a new row", () => {
  it("accepts a registration carrying every clinical field", () => {
    const result = CreateEquipmentRequestSchema.safeParse(validCreate);
    expect(result.success).toBe(true);
  });

  it.each(["modality", "brand", "model", "serialNumber", "roomLabel", "installedAt"] as const)(
    "rejects a registration missing %s, even though the column itself is nullable",
    (field) => {
      const { [field]: _omitted, ...withoutField } = validCreate;
      expect(CreateEquipmentRequestSchema.safeParse(withoutField).success).toBe(false);
    }
  );

  it.each(["brand", "model", "serialNumber", "roomLabel"] as const)(
    "rejects whitespace-only %s -- a blank string would satisfy a naive required check while carrying no information",
    (field) => {
      expect(CreateEquipmentRequestSchema.safeParse({ ...validCreate, [field]: "   " }).success).toBe(false);
    }
  );

  it("trims the free-text clinical fields rather than storing the operator's stray spaces", () => {
    const result = CreateEquipmentRequestSchema.parse({ ...validCreate, brand: "  Siemens  " });
    expect(result.brand).toBe("Siemens");
  });

  it("anchors a bare YYYY-MM-DD install date at UTC midnight, so it cannot shift a day backwards for a negative-offset user", () => {
    const result = CreateEquipmentRequestSchema.parse({ ...validCreate, installedAt: "2025-12-21" });
    expect(result.installedAt.toISOString()).toBe("2025-12-21T00:00:00.000Z");
  });

  it("still applies the existing teleoperation defaults, which this change must not have disturbed", () => {
    const result = CreateEquipmentRequestSchema.parse(validCreate);
    expect(result.keymap).toBe("en-us");
    expect(result.mouseMode).toBe(MouseMode.ABSOLUTE);
    expect(result.screenWidth).toBe(1920);
    expect(result.screenHeight).toBe(1080);
  });

  it("rejects an unknown modality string -- the listing screen's per-modality counters only handle the closed set", () => {
    expect(CreateEquipmentRequestSchema.safeParse({ ...validCreate, modality: "MAMMOGRAPHY" }).success).toBe(false);
  });

  it("accepts XRAY -- added to the shared ExamModality enum alongside the unit-registration feature", () => {
    expect(CreateEquipmentRequestSchema.safeParse({ ...validCreate, modality: ExamModality.XRAY }).success).toBe(true);
  });
});

describe("CreateEquipmentRequestSchema -- DICOM metadata is optional but still validated", () => {
  it("accepts a registration with no DICOM details at all, since nothing in this platform uses them", () => {
    expect(CreateEquipmentRequestSchema.safeParse(validCreate).success).toBe(true);
  });

  it("accepts a conventional AE Title", () => {
    expect(CreateEquipmentRequestSchema.safeParse({ ...validCreate, aeTitle: "RADLINK_MR01" }).success).toBe(true);
  });

  /**
   * A regression guard for a real bug. These fields were `.optional()` (absent only) on create
   * while being `.nullable()` on update, so a form that sent `{aeTitle: null}` for a blank
   * input -- the obvious thing to do, and what the equipment form does -- succeeded when
   * editing and failed with a 400 when creating. For a field whose entire meaning is "may have
   * no value," absent and null have to be the same statement.
   */
  it.each(["aeTitle", "dicomIp", "dicomPort", "cameraUrl"] as const)(
    "accepts an explicit null for %s, not just an absent key -- the two mean the same thing here",
    (field) => {
      const result = CreateEquipmentRequestSchema.safeParse({ ...validCreate, [field]: null });
      expect(result.success).toBe(true);
    }
  );

  it("rejects an AE Title over DICOM's 16-character limit -- storing a value the external PACS would reject is worse than storing nothing", () => {
    expect(CreateEquipmentRequestSchema.safeParse({ ...validCreate, aeTitle: "A".repeat(17) }).success).toBe(false);
  });

  it("rejects a lowercase or space-bearing AE Title", () => {
    expect(CreateEquipmentRequestSchema.safeParse({ ...validCreate, aeTitle: "radlink mr01" }).success).toBe(false);
  });

  it("accepts a hostname in dicomIp -- PACS nodes are routinely addressed by name, so this is not an IP-only field", () => {
    expect(CreateEquipmentRequestSchema.safeParse({ ...validCreate, dicomIp: "pacs.hospital.local" }).success).toBe(true);
  });

  it.each([0, 65536, 1.5])("rejects %s as a DICOM port", (port) => {
    expect(CreateEquipmentRequestSchema.safeParse({ ...validCreate, dicomPort: port }).success).toBe(false);
  });
});

describe("UpdateEquipmentRequestSchema", () => {
  it("accepts an empty patch -- every field is optional, this is a real partial update", () => {
    expect(UpdateEquipmentRequestSchema.safeParse({}).success).toBe(true);
  });

  it("accepts changing one clinical field alone, without resending the rest", () => {
    const result = UpdateEquipmentRequestSchema.safeParse({ roomLabel: "Sala TC-02 - 1o Andar" });
    expect(result.success).toBe(true);
  });

  it.each(["brand", "model", "serialNumber", "roomLabel", "modality"] as const)(
    "refuses to null out %s: an update may leave a clinical field alone but may not walk a row back into the historical-null set",
    (field) => {
      expect(UpdateEquipmentRequestSchema.safeParse({ [field]: null }).success).toBe(false);
    }
  );

  it.each(["aeTitle", "dicomIp", "dicomPort"] as const)(
    "does allow nulling out %s, because 'this device has no PACS entry after all' is a legitimate correction",
    (field) => {
      expect(UpdateEquipmentRequestSchema.safeParse({ [field]: null }).success).toBe(true);
    }
  );
});
