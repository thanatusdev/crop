import { describe, expect, it } from "vitest";
import { computeAuditHash, verifyAuditChain, type HashChainInput } from "../src/audit/hash-chain.js";

function makeRow(overrides: Partial<HashChainInput> = {}): HashChainInput {
  return {
    tenantId: "11111111-1111-1111-1111-111111111111",
    seq: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    userId: "22222222-2222-2222-2222-222222222222",
    action: "LOGIN_SUCCESS",
    resourceType: "User",
    resourceId: null,
    details: { ip: "10.0.0.1" },
    prevHash: null,
    ...overrides,
  };
}

describe("computeAuditHash", () => {
  it("is deterministic for identical input", async () => {
    const row = makeRow();
    expect(await computeAuditHash(row)).toBe(await computeAuditHash(row));
  });

  it("changes when any field changes, including deeply nested details", async () => {
    const base = await computeAuditHash(makeRow());
    const tampered = await computeAuditHash(makeRow({ details: { ip: "10.0.0.2" } }));
    expect(base).not.toBe(tampered);
  });

  it("changes when prevHash changes, chaining this row to its predecessor", async () => {
    const a = await computeAuditHash(makeRow({ prevHash: null }));
    const b = await computeAuditHash(makeRow({ prevHash: "somehash" }));
    expect(a).not.toBe(b);
  });
});

describe("verifyAuditChain", () => {
  it("validates an intact chain", async () => {
    const row1 = makeRow({ seq: 1, prevHash: null });
    const hash1 = await computeAuditHash(row1);
    const row2 = makeRow({ seq: 2, prevHash: hash1, action: "SESSION_START" });
    const hash2 = await computeAuditHash(row2);

    const result = await verifyAuditChain([row1, row2], [hash1, hash2]);
    expect(result).toEqual({ valid: true, brokenAtIndex: null });
  });

  it("detects a tampered row -- the exact scenario demoed on stage", async () => {
    const row1 = makeRow({ seq: 1, prevHash: null });
    const hash1 = await computeAuditHash(row1);
    const row2 = makeRow({ seq: 2, prevHash: hash1, action: "SESSION_START" });
    const hash2 = await computeAuditHash(row2);

    // Simulate someone editing row1's details directly in the database after the fact.
    const tamperedRow1 = { ...row1, details: { ip: "tampered" } };

    const result = await verifyAuditChain([tamperedRow1, row2], [hash1, hash2]);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
  });
});
