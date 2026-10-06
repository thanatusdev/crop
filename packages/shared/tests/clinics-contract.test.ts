import { describe, expect, it } from "vitest";
import { TenantType } from "../src/enums.js";
import { CreateTenantRequestSchema, UpdateTenantRequestSchema } from "../src/contracts/tenants.js";

/**
 * `Tenant`'s institutional/address columns are nullable in Postgres (rows predating this
 * feature, and the one `PLATFORM` tenant, have no honest value for them -- see the
 * clinic_registry migration's own note), so the only thing keeping a new CLINIC or
 * OPERATOR_PROVIDER row from joining that null set is `CreateTenantRequestSchema`'s
 * `.superRefine` -- there is no NOT NULL constraint backing it up, which is exactly why this
 * is worth testing directly.
 */

const validClinic = {
  name: "Clinica do Rafael Diagnósticos",
  type: TenantType.CLINIC,
  cnpj: "12.345.678/0001-95", // real check-digit-valid CNPJ, see cnpj.test.ts
  institutionalEmail: "teste@teste.com.br",
  phone: "(11) 3456-7890",
  zipCode: "03042-001",
  street: "Rua Vergueiro",
  number: "1234",
  district: "Centro",
  city: "São Paulo",
  state: "SP",
};

describe("CreateTenantRequestSchema -- institutional identity is mandatory for a new CLINIC", () => {
  it("accepts a CLINIC registration carrying every required field", () => {
    expect(CreateTenantRequestSchema.safeParse(validClinic).success).toBe(true);
  });

  it("normalizes a punctuated CNPJ to digits-only", () => {
    const result = CreateTenantRequestSchema.parse(validClinic);
    expect(result.cnpj).toBe("12345678000195");
  });

  it.each(["cnpj", "institutionalEmail", "phone", "zipCode", "street", "number", "district", "city", "state"] as const)(
    "rejects a CLINIC registration missing %s, even though the column itself is nullable",
    (field) => {
      const { [field]: _omitted, ...withoutField } = validClinic;
      expect(CreateTenantRequestSchema.safeParse(withoutField).success).toBe(false);
    }
  );

  it("rejects a CNPJ that fails the check-digit algorithm", () => {
    expect(CreateTenantRequestSchema.safeParse({ ...validClinic, cnpj: "12.345.678/0001-94" }).success).toBe(false);
  });

  it("rejects a malformed institutional e-mail", () => {
    expect(CreateTenantRequestSchema.safeParse({ ...validClinic, institutionalEmail: "not-an-email" }).success).toBe(false);
  });

  it("rejects an unknown state (UF)", () => {
    expect(CreateTenantRequestSchema.safeParse({ ...validClinic, state: "ZZ" }).success).toBe(false);
  });

  it("accepts an explicit null for complement, not just an absent key", () => {
    expect(CreateTenantRequestSchema.safeParse({ ...validClinic, complement: null }).success).toBe(true);
  });

  it("defaults an omitted type to CLINIC -- which means the institutional fields are still required", () => {
    const { type: _type, ...withoutType } = validClinic;
    expect(CreateTenantRequestSchema.parse(withoutType).type).toBe(TenantType.CLINIC);
    const { type: _type2, cnpj: _cnpj, ...withoutTypeOrCnpj } = validClinic;
    expect(CreateTenantRequestSchema.safeParse(withoutTypeOrCnpj).success).toBe(false);
  });
});

const validOperator = {
  name: "Operadora Central",
  type: TenantType.OPERATOR_PROVIDER,
  cnpj: "11.122.233/0001-83", // real check-digit-valid CNPJ, distinct root from validClinic's
  institutionalEmail: "contato@operadoracentral.com.br",
  phone: "(11) 2345-6789",
  zipCode: "04567-002",
  street: "Avenida Paulista",
  number: "900",
  district: "Bela Vista",
  city: "São Paulo",
  state: "SP",
};

describe("CreateTenantRequestSchema -- institutional identity is mandatory for an OPERATOR_PROVIDER too", () => {
  it("accepts an OPERATOR_PROVIDER registration carrying every required field, the same set a CLINIC needs", () => {
    expect(CreateTenantRequestSchema.safeParse(validOperator).success).toBe(true);
  });

  it.each(["cnpj", "institutionalEmail", "phone", "zipCode", "street", "number", "district", "city", "state"] as const)(
    "rejects an OPERATOR_PROVIDER registration missing %s -- no longer exempt from this now that it has its own registration screen",
    (field) => {
      const { [field]: _omitted, ...withoutField } = validOperator;
      expect(CreateTenantRequestSchema.safeParse(withoutField).success).toBe(false);
    }
  );

  it("rejects an OPERATOR_PROVIDER with no name, same as any other tenant", () => {
    expect(CreateTenantRequestSchema.safeParse({ ...validOperator, name: "" }).success).toBe(false);
  });
});

describe("UpdateTenantRequestSchema", () => {
  it("accepts an empty patch -- every field is optional, this is a real partial update", () => {
    expect(UpdateTenantRequestSchema.safeParse({}).success).toBe(true);
  });

  it("accepts changing one address field alone, without resending the rest", () => {
    expect(UpdateTenantRequestSchema.safeParse({ city: "Campinas" }).success).toBe(true);
  });

  it.each(["street", "number", "district", "city", "state", "institutionalEmail", "phone"] as const)(
    "refuses to null out %s: an update may leave a required-on-create field alone but may not walk it back into the historical-null set",
    (field) => {
      expect(UpdateTenantRequestSchema.safeParse({ [field]: null }).success).toBe(false);
    }
  );

  it("does allow nulling out responsibleManagerId -- unlike every other required-on-create field, a manager can legitimately become unassigned", () => {
    expect(UpdateTenantRequestSchema.safeParse({ responsibleManagerId: null }).success).toBe(true);
  });

  it("does allow nulling out complement, since it was optional even at creation", () => {
    expect(UpdateTenantRequestSchema.safeParse({ complement: null }).success).toBe(true);
  });

  it("has no cnpj field at all -- a clinic's CNPJ is fixed at creation, not reassignable via update", () => {
    const result = UpdateTenantRequestSchema.parse({ cnpj: "11.222.333/0001-81", name: "Renamed" });
    expect(result).not.toHaveProperty("cnpj");
  });

  it("has no type field at all -- a tenant's type is fixed for its whole lifetime", () => {
    const result = UpdateTenantRequestSchema.parse({ type: "OPERATOR_PROVIDER", name: "Renamed" });
    expect(result).not.toHaveProperty("type");
  });
});
