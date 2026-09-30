import { describe, expect, it } from "vitest";
import { cnpjBranchOrder, cnpjRoot, formatCnpj, isMatrizCnpj, isValidCnpj, normalizeCnpj } from "../src/cnpj.js";

// Genuine check-digit-valid CNPJs, computed with this module's own algorithm against three
// hand-picked 12-digit bases -- not real-world registrations, but structurally
// indistinguishable from one, which is the property these tests actually need.
const MATRIZ = "12345678000195"; // root 12345678, branch 0001
const FILIAL = "12345678000276"; // same root, branch 0002
const OTHER_ROOT_MATRIZ = "11122233000183";

describe("normalizeCnpj / formatCnpj", () => {
  it("strips punctuation down to digits", () => {
    expect(normalizeCnpj("12.345.678/0001-95")).toBe(MATRIZ);
  });

  it("formats digits back into the punctuated XX.XXX.XXX/XXXX-XX shape", () => {
    expect(formatCnpj(MATRIZ)).toBe("12.345.678/0001-95");
  });
});

describe("isValidCnpj -- the actual check-digit algorithm, not just a shape check", () => {
  it("accepts a CNPJ whose check digits are genuinely correct", () => {
    expect(isValidCnpj(MATRIZ)).toBe(true);
    expect(isValidCnpj(FILIAL)).toBe(true);
    expect(isValidCnpj(OTHER_ROOT_MATRIZ)).toBe(true);
  });

  it("accepts the same CNPJ formatted with punctuation -- validation normalizes first", () => {
    expect(isValidCnpj("12.345.678/0001-95")).toBe(true);
  });

  it("rejects a CNPJ with a single check digit flipped", () => {
    expect(isValidCnpj("12345678000194")).toBe(false); // last digit off by one
    expect(isValidCnpj("12345678000185")).toBe(false); // first check digit off by one
  });

  it("rejects a CNPJ with a transposed digit in the base", () => {
    expect(isValidCnpj("21345678000195")).toBe(false);
  });

  it("rejects anything that isn't exactly 14 digits", () => {
    expect(isValidCnpj("123456780001")).toBe(false); // 12 digits
    expect(isValidCnpj("1234567800019500")).toBe(false); // 16 digits
    expect(isValidCnpj("")).toBe(false);
  });

  it.each(["00000000000000", "11111111111111", "99999999999999"])(
    "rejects the degenerate all-same-digit string %s, even though the checksum alone doesn't rule it out",
    (allSame) => {
      expect(isValidCnpj(allSame)).toBe(false);
    }
  );
});

describe("cnpjRoot / cnpjBranchOrder / isMatrizCnpj -- the matriz/filial derivation", () => {
  it("extracts the same 8-digit root from a matriz and its filial", () => {
    expect(cnpjRoot(MATRIZ)).toBe("12345678");
    expect(cnpjRoot(FILIAL)).toBe("12345678");
  });

  it("extracts a different root for an unrelated CNPJ", () => {
    expect(cnpjRoot(OTHER_ROOT_MATRIZ)).not.toBe(cnpjRoot(MATRIZ));
  });

  it("reads the branch order from digits 9-12", () => {
    expect(cnpjBranchOrder(MATRIZ)).toBe("0001");
    expect(cnpjBranchOrder(FILIAL)).toBe("0002");
  });

  it("treats branch order 0001 as the matriz, and anything else as a filial", () => {
    expect(isMatrizCnpj(MATRIZ)).toBe(true);
    expect(isMatrizCnpj(FILIAL)).toBe(false);
  });
});
