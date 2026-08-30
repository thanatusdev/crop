/** Linear remap, identical to PiKVM's own `tools.remap`. */
export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return Math.round(((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin);
}

export interface StreamGeometry {
  /** Offset of the actual video content within the stream element (letterbox/pillarbox). */
  x: number;
  y: number;
  /** Size of the actual video content, in the same pixel space as the pointer event. */
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Converts a pointer position (relative to the stream container, e.g. from
 * `getBoundingClientRect()`) into PiKVM's absolute HID coordinate space: signed 16-bit,
 * origin at the centre of the screen (-32768..32767 on each axis). Matches PiKVM's own
 * `mouse.js` `__sendPlannedMove` exactly, including the geometry offset subtraction that
 * accounts for letterboxing when the video's aspect ratio doesn't match the container's.
 */
export function toAbsoluteHidCoordinates(pos: Point, geo: StreamGeometry): Point {
  return {
    x: remap(pos.x - geo.x, 0, geo.width - 1, -32768, 32767),
    y: remap(pos.y - geo.y, 0, geo.height - 1, -32768, 32767),
  };
}

/** Relative mouse deltas must be clamped to a signed byte, per PiKVM's USB relative HID report. */
export function clampRelativeDelta(delta: number): number {
  return Math.min(Math.max(-127, Math.floor(delta)), 127);
}

/**
 * Converts a continuous wheel delta (e.g. `WheelEvent.deltaY`) into PiKVM's discrete scroll
 * step protocol: PiKVM expects a signed step, not a raw pixel delta, sent once per "notch".
 * `rate` mirrors PiKVM's configurable scroll rate (default 5).
 */
export function toScrollStep(delta: number, rate: number, reverse: boolean): number {
  if (delta === 0) return 0;
  const step = Math.sign(delta) * -rate;
  return reverse ? -step : step;
}
