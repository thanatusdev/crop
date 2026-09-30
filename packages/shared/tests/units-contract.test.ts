import { describe, expect, it } from "vitest";
import { EstablishmentType, ExamModality } from "../src/enums.js";
import { CreateUnitRequestSchema, UpdateUnitRequestSchema } from "../src/contracts/units.js";

/**
 * `Unit`'s institutional/regulatory columns (establishmentType, technicalManagerId,
 * declaredModalities, and the address block) are all nullable in Postgres -- rows predating
 * the registration screen, including every clinic's migration-backfilled "Unidade
 * Principal", have no honest value for them (see the unit_registry migration's own note).
 * The only thing stopping a new row from joining that null set is
 * `CreateUnitRequestSchema` requiring them -- there is no NOT NULL constraint backing it up,
 * which is exactly why this is worth testing directly rather than trusting the schema to
 * stay written the way it is now.
 */

const validCreate = {
  name: "Unidade Jardins",
  establishmentType: EstablishmentType.LABORATORY,
  technicalManagerId: "8c9c5e2a-6c1b-4b8b-9b1a-1f2e3d4c5b6a",
  declaredModalities: [ExamModality.MRI, ExamModality.CT],
  zipCode: "01310-100",
  street: "Avenida Paulista",
  number: "1000",
  district: "Bela Vista",
  city: "São Paulo",
  state: "SP",
};

describe("CreateUnitRequestSchema -- institutional identity and address are mandatory for a new unit", () => {
  it("accepts a registration carrying every required field", () => {
    expect(CreateUnitRequestSchema.safeParse(validCreate).success).toBe(true);
  });

  it.each([
    "establishmentType",
    "technicalManagerId",
    "declaredModalities",
    "zipCode",
    "street",
    "number",
    "district",
    "city",
    "state",
  ] as const)("rejects a registration missing %s, even though the column itself is nullable", (field) => {
    const { [field]: _omitted, ...withoutField } = validCreate;
    expect(CreateUnitRequestSchema.safeParse(withoutField).success).toBe(false);
  });

  it("rejects an empty declaredModalities array -- a unit must declare at least one modality", () => {
    expect(CreateUnitRequestSchema.safeParse({ ...validCreate, declaredModalities: [] }).success).toBe(false);
  });

  it("accepts XRAY as a declared modality", () => {
    const result = CreateUnitRequestSchema.safeParse({ ...validCreate, declaredModalities: [ExamModality.XRAY] });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown establishment type -- the listing screen's TIPO filter only handles the closed set", () => {
    expect(CreateUnitRequestSchema.safeParse({ ...validCreate, establishmentType: "PHARMACY" }).success).toBe(false);
  });

  it("rejects an unknown state (UF)", () => {
    expect(CreateUnitRequestSchema.safeParse({ ...validCreate, state: "ZZ" }).success).toBe(false);
  });

  it("normalizes a CEP typed without the hyphen to NNNNN-NNN", () => {
    const result = CreateUnitRequestSchema.parse({ ...validCreate, zipCode: "01310100" });
    expect(result.zipCode).toBe("01310-100");
  });

  it("rejects a CEP that isn't 8 digits", () => {
    expect(CreateUnitRequestSchema.safeParse({ ...validCreate, zipCode: "123" }).success).toBe(false);
  });

  it("rejects whitespace-only required text fields, which would satisfy a naive required check while carrying no information", () => {
    expect(CreateUnitRequestSchema.safeParse({ ...validCreate, street: "   " }).success).toBe(false);
  });
});

describe("CreateUnitRequestSchema -- CNES/phone/e-mail are optional, but still validated", () => {
  it("accepts a registration with none of them", () => {
    expect(CreateUnitRequestSchema.safeParse(validCreate).success).toBe(true);
  });

  it("accepts an explicit null for cnesCode/phone/technicalEmail/complement, not just an absent key", () => {
    for (const field of ["cnesCode", "phone", "technicalEmail", "complement"] as const) {
      expect(CreateUnitRequestSchema.safeParse({ ...validCreate, [field]: null }).success).toBe(true);
    }
  });

  it("accepts a well-formed e-mail and rejects a malformed one", () => {
    expect(CreateUnitRequestSchema.safeParse({ ...validCreate, technicalEmail: "unidade01@clinica1.com.br" }).success).toBe(true);
    expect(CreateUnitRequestSchema.safeParse({ ...validCreate, technicalEmail: "not-an-email" }).success).toBe(false);
  });

  it("accepts a conventionally formatted phone number and rejects letters", () => {
    expect(CreateUnitRequestSchema.safeParse({ ...validCreate, phone: "(11) 3456-7890" }).success).toBe(true);
    expect(CreateUnitRequestSchema.safeParse({ ...validCreate, phone: "call me maybe" }).success).toBe(false);
  });
});

describe("UpdateUnitRequestSchema", () => {
  it("accepts an empty patch -- every field is optional, this is a real partial update", () => {
    expect(UpdateUnitRequestSchema.safeParse({}).success).toBe(true);
  });

  it("accepts changing one address field alone, without resending the rest", () => {
    expect(UpdateUnitRequestSchema.safeParse({ district: "Jardins" }).success).toBe(true);
  });

  it.each(["street", "number", "district", "city", "state", "establishmentType", "declaredModalities"] as const)(
    "refuses to null out %s: an update may leave a required-on-create field alone but may not walk it back into the historical-null set",
    (field) => {
      expect(UpdateUnitRequestSchema.safeParse({ [field]: null }).success).toBe(false);
    }
  );

  it("does allow nulling out technicalManagerId -- unlike every other required-on-create field, a manager can legitimately become unassigned", () => {
    expect(UpdateUnitRequestSchema.safeParse({ technicalManagerId: null }).success).toBe(true);
  });

  it.each(["cnesCode", "phone", "technicalEmail", "complement"] as const)(
    "does allow nulling out %s, because 'we don't have this on file' is a legitimate correction",
    (field) => {
      expect(UpdateUnitRequestSchema.safeParse({ [field]: null }).success).toBe(true);
    }
  );

  it("has no clinicTenantId field at all -- a unit's clinic is fixed at creation, not reassignable via update", () => {
    // Zod silently strips unrecognized keys by default (the same behavior every other
    // schema in this codebase relies on), so this asserts the key is simply gone from the
    // parsed result, whatever value was sent -- not that sending it is rejected outright.
    const result = UpdateUnitRequestSchema.parse({ clinicTenantId: "8c9c5e2a-6c1b-4b8b-9b1a-1f2e3d4c5b6a", name: "Renamed" });
    expect(result).not.toHaveProperty("clinicTenantId");
  });

  it("still normalizes a hyphen-less CEP on update", () => {
    const result = UpdateUnitRequestSchema.parse({ zipCode: "01310100" });
    expect(result.zipCode).toBe("01310-100");
  });
});
