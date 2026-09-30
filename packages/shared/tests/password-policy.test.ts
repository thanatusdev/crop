import { describe, expect, it } from "vitest";
import {
  evaluatePassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RECOMMENDED_LENGTH,
  type PasswordEvaluationContext,
} from "../src/password-policy.js";

const ctx: PasswordEvaluationContext = { email: "dr.ricardo.silva@radlink.med.br", firstName: "Ricardo", lastName: "Silva" };

describe("evaluatePassword", () => {
  it("passes a password satisfying every rule", () => {
    const result = evaluatePassword("Kx7#mQ2p", ctx);
    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.satisfied).toHaveLength(5);
  });

  it("fails a password under the minimum length", () => {
    const result = evaluatePassword("Kx7#mQ", ctx);
    expect(result.ok).toBe(false);
    expect(result.failed).toContain("minLength");
  });

  it("fails a password with only one letter case", () => {
    expect(evaluatePassword("kx7#mq2p", ctx).failed).toContain("mixedCase");
    expect(evaluatePassword("KX7#MQ2P", ctx).failed).toContain("mixedCase");
  });

  it("fails a password with no digit", () => {
    expect(evaluatePassword("Kxxx#mqp", ctx).failed).toContain("digit");
  });

  it("fails a password with no symbol", () => {
    expect(evaluatePassword("Kx72mQ2p", ctx).failed).toContain("symbol");
  });

  it("rejects the account's own first name, case-insensitively", () => {
    const result = evaluatePassword("RicardoForte1!", ctx);
    expect(result.ok).toBe(false);
    expect(result.failed).toContain("noPersonalInfo");
  });

  it("rejects the account's own last name", () => {
    expect(evaluatePassword("Silva1234!", ctx).failed).toContain("noPersonalInfo");
  });

  it("rejects a token from the email local-part even with no firstName/lastName supplied", () => {
    const bareCtx: PasswordEvaluationContext = { email: "dr.ricardo.silva@radlink.med.br" };
    expect(evaluatePassword("Ricardo123!", bareCtx).failed).toContain("noPersonalInfo");
  });

  it("rejects the brand name regardless of the account", () => {
    expect(evaluatePassword("RadLink123!", ctx).failed).toContain("noPersonalInfo");
    expect(evaluatePassword("MyCropPass1!", ctx).failed).toContain("noPersonalInfo");
  });

  it("does not reject the 2-character 'dr' prefix as personal info", () => {
    // "dr" alone would otherwise match almost anything containing those two letters --
    // dropped by the 3-character floor.
    const result = evaluatePassword("DrStrange1!", ctx);
    expect(result.failed).not.toContain("noPersonalInfo");
  });

  it("does not treat a purely numeric email-local-part token as personal info", () => {
    // Guards against exactly the collision that would otherwise hit test fixtures: an email
    // like `reset-happy-a1b2c3d4@test.crop.health` splits into a token that could
    // coincidentally contain the digits from an unrelated fixture password. A name token is
    // never all-digits, so numeric-only tokens are dropped entirely, not just short ones.
    const numericCtx: PasswordEvaluationContext = { email: "user-88221199@test.crop.health" };
    expect(evaluatePassword("Password8822!", numericCtx).failed).not.toContain("noPersonalInfo");
  });

  it("does not reject the email domain as personal info", () => {
    // "health" from `@alpha.crop.health` must never itself cause a rejection -- only the
    // fixed brand denylist and the local-part/name tokens do.
    const result = evaluatePassword("HealthyPass1!", { email: "someone@alpha.crop.health" });
    expect(result.failed).not.toContain("noPersonalInfo");
  });

  it("flags meetsRecommendedLength independently of ok, and never blocks on it", () => {
    const short = evaluatePassword("Kx7#mQ2p", ctx); // 8 chars: passes, but below 10
    expect(short.ok).toBe(true);
    expect(short.meetsRecommendedLength).toBe(false);

    const long = evaluatePassword("Kx7#mQ2pAB", ctx); // 10 chars
    expect(long.meetsRecommendedLength).toBe(true);
  });

  it("exposes the constants the frontend copy quotes", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_RECOMMENDED_LENGTH).toBe(10);
  });

  it("every one of this repo's existing fixture passwords already satisfies the policy", () => {
    // Documents the blast-radius check done before this feature was built: none of these
    // needed to change when the policy was added.
    const fixtures = [
      "SenhaForte123!",
      "TestPassword123!",
      "Whatever123!",
      "BrandNewUser123!",
      "CrossTenant123!",
      "TempPassword789!",
      "LoadTest123!",
      "WrongPassword123!",
    ];
    for (const password of fixtures) {
      expect(evaluatePassword(password, { email: "fixture@test.crop.health" }).ok, password).toBe(true);
    }
  });
});
