import { describe, expect, it } from "vitest";
import { remap, toAbsoluteHidCoordinates, clampRelativeDelta, toScrollStep } from "../src/hid/mouse-math.js";

describe("remap", () => {
  it("maps the centre of the input range to the centre of the output range", () => {
    expect(remap(960, 0, 1919, -32768, 32767)).toBeCloseTo(0, -2);
  });

  it("maps the min/max of the input range to min/max of the output range", () => {
    expect(remap(0, 0, 1919, -32768, 32767)).toBe(-32768);
    expect(remap(1919, 0, 1919, -32768, 32767)).toBe(32767);
  });
});

describe("toAbsoluteHidCoordinates", () => {
  it("converts a pointer position with no letterboxing", () => {
    const geo = { x: 0, y: 0, width: 1920, height: 1080 };
    const result = toAbsoluteHidCoordinates({ x: 0, y: 0 }, geo);
    expect(result).toEqual({ x: -32768, y: -32768 });
  });

  it("subtracts the geometry offset for a letterboxed (pillarboxed) video element", () => {
    // A 16:9 video centred in a wider container leaves 100px of empty space on each side.
    const geo = { x: 100, y: 0, width: 1920, height: 1080 };
    const clickAtVideoOrigin = toAbsoluteHidCoordinates({ x: 100, y: 0 }, geo);
    expect(clickAtVideoOrigin).toEqual({ x: -32768, y: -32768 });

    // A click in the letterbox padding (x=50, before the video starts) must not be silently
    // clamped into the video's coordinate space -- it should extrapolate below -32768,
    // proving the offset subtraction actually ran instead of being skipped.
    const clickInPadding = toAbsoluteHidCoordinates({ x: 50, y: 0 }, geo);
    expect(clickInPadding.x).toBeLessThan(-32768);
  });
});

describe("clampRelativeDelta", () => {
  it("passes through values within the signed byte range", () => {
    expect(clampRelativeDelta(50)).toBe(50);
    expect(clampRelativeDelta(-50)).toBe(-50);
  });

  it("clamps to the USB relative HID report's signed byte range", () => {
    expect(clampRelativeDelta(500)).toBe(127);
    expect(clampRelativeDelta(-500)).toBe(-127);
  });
});

describe("toScrollStep", () => {
  it("returns zero for no movement", () => {
    expect(toScrollStep(0, 5, false)).toBe(0);
  });

  it("produces a fixed-size step in the sign-inverted direction, per PiKVM's protocol", () => {
    expect(toScrollStep(10, 5, false)).toBe(-5);
    expect(toScrollStep(-10, 5, false)).toBe(5);
  });

  it("re-inverts when the reverse-scrolling preference is set", () => {
    expect(toScrollStep(10, 5, true)).toBe(5);
  });
});
