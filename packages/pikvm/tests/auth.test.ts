import { describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import { buildAuthHeaders, buildPassword } from "../src/auth.js";

describe("buildPassword", () => {
  it("returns the plain password when the device has no TOTP secret", () => {
    expect(buildPassword({ baseUrl: "https://pikvm", user: "admin", password: "admin" })).toBe("admin");
  });

  it("concatenates the current TOTP code directly onto the password, no separator", () => {
    const totpSecret = "3OBBOGSJRYRBZH35PGXURM4CMWTH3WSU";
    const totp = new OTPAuth.TOTP({ secret: totpSecret });
    const expectedCode = totp.generate();

    const password = buildPassword({ baseUrl: "https://pikvm", user: "admin", password: "admin", totpSecret });
    expect(password).toBe(`admin${expectedCode}`);
  });
});

describe("buildAuthHeaders", () => {
  it("produces the X-KVMD-User / X-KVMD-Passwd headers PiKVM expects", () => {
    const headers = buildAuthHeaders({ baseUrl: "https://pikvm", user: "admin", password: "admin" });
    expect(headers).toEqual({ "X-KVMD-User": "admin", "X-KVMD-Passwd": "admin" });
  });
});
