/**
 * Hash-chains the AuditLog table so tampering is *detectable*, not just prevented by
 * DB permissions. Each row's hash covers its own payload plus the previous row's hash
 * (per tenant), so altering or deleting a historical row breaks every hash after it.
 *
 * Uses Web Crypto (`SubtleCrypto`), available in Node 20+ as `globalThis.crypto` and in every
 * browser, so this file has zero platform-specific dependency despite only actually running
 * server-side today.
 */

export interface HashChainInput {
  tenantId: string;
  seq: number;
  timestamp: string; // ISO 8601
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: unknown;
  prevHash: string | null;
}

function canonicalize(input: HashChainInput): string {
  // Stable field order matters: this string is what gets hashed, so it must be reproduced
  // identically at verification time. Do not switch to JSON.stringify(object) directly --
  // key order in JS objects is insertion order, which is easy to accidentally change.
  return [
    input.tenantId,
    String(input.seq),
    input.timestamp,
    input.userId ?? "",
    input.action,
    input.resourceType,
    input.resourceId ?? "",
    JSON.stringify(input.details ?? null),
    input.prevHash ?? "",
  ].join("|");
}

export async function computeAuditHash(input: HashChainInput): Promise<string> {
  const data = new TextEncoder().encode(canonicalize(input));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}

export async function verifyAuditChain(
  rows: HashChainInput[],
  expectedHashes: string[]
): Promise<{ valid: boolean; brokenAtIndex: number | null }> {
  for (let i = 0; i < rows.length; i++) {
    const computed = await computeAuditHash(rows[i]);
    if (computed !== expectedHashes[i]) {
      return { valid: false, brokenAtIndex: i };
    }
  }
  return { valid: true, brokenAtIndex: null };
}
