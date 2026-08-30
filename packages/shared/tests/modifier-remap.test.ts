import { describe, expect, it } from "vitest";
import { remapModifierCode, fixIsoBackquote, decideAltGrCtrl } from "../src/hid/modifier-remap.js";
import { TargetOs } from "../src/enums.js";

describe("remapModifierCode", () => {
  it("does not touch modifiers when client and target share the same convention", () => {
    expect(remapModifierCode("ControlLeft", TargetOs.WINDOWS, TargetOs.LINUX)).toBe("ControlLeft");
    expect(remapModifierCode("MetaLeft", TargetOs.MACOS, TargetOs.MACOS)).toBe("MetaLeft");
  });

  it("swaps Control<->Meta when a Windows/Linux operator controls a macOS target", () => {
    expect(remapModifierCode("ControlLeft", TargetOs.WINDOWS, TargetOs.MACOS)).toBe("MetaLeft");
    expect(remapModifierCode("ControlRight", TargetOs.WINDOWS, TargetOs.MACOS)).toBe("MetaRight");
    expect(remapModifierCode("MetaLeft", TargetOs.WINDOWS, TargetOs.MACOS)).toBe("ControlLeft");
  });

  it("swaps Control<->Meta when a macOS operator controls a Windows/Linux target (the demo's own setup)", () => {
    expect(remapModifierCode("MetaLeft", TargetOs.MACOS, TargetOs.WINDOWS)).toBe("ControlLeft");
    expect(remapModifierCode("ControlLeft", TargetOs.MACOS, TargetOs.WINDOWS)).toBe("MetaLeft");
  });

  it("leaves Alt and Shift untouched regardless of platform combination", () => {
    expect(remapModifierCode("AltLeft", TargetOs.MACOS, TargetOs.WINDOWS)).toBe("AltLeft");
    expect(remapModifierCode("ShiftRight", TargetOs.WINDOWS, TargetOs.MACOS)).toBe("ShiftRight");
  });

  it("leaves non-modifier keys untouched", () => {
    expect(remapModifierCode("KeyC", TargetOs.MACOS, TargetOs.WINDOWS)).toBe("KeyC");
  });
});

describe("fixIsoBackquote", () => {
  it("corrects IntlBackslash reported for a backtick/tilde key (pikvm/pikvm#819)", () => {
    expect(fixIsoBackquote("IntlBackslash", "`")).toBe("Backquote");
    expect(fixIsoBackquote("IntlBackslash", "~")).toBe("Backquote");
  });

  it("corrects Backquote reported for a section-sign key", () => {
    expect(fixIsoBackquote("Backquote", "\u00a7")).toBe("IntlBackslash");
  });

  it("leaves unrelated codes untouched", () => {
    expect(fixIsoBackquote("KeyA", "a")).toBe("KeyA");
  });
});

describe("decideAltGrCtrl", () => {
  it("suppresses and schedules on a bare ControlLeft down", () => {
    expect(decideAltGrCtrl("ControlLeft", true, false)).toEqual({ action: "suppress-and-schedule" });
  });

  it("cancels the pending Ctrl when AltRight follows (real AltGr chord)", () => {
    expect(decideAltGrCtrl("AltRight", true, true)).toEqual({ action: "cancel-pending" });
  });

  it("cancels the pending Ctrl when it is released before the timer fires", () => {
    expect(decideAltGrCtrl("ControlLeft", false, true)).toEqual({ action: "cancel-pending" });
  });

  it("fires the pending Ctrl then forwards when an unrelated key arrives (a real Ctrl+X chord)", () => {
    expect(decideAltGrCtrl("KeyX", true, true)).toEqual({ action: "fire-pending-then-forward" });
  });

  it("forwards unrelated events when nothing is pending", () => {
    expect(decideAltGrCtrl("KeyA", true, false)).toEqual({ action: "forward" });
  });
});
