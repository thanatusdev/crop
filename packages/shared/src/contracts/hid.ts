import { z } from "zod";

/**
 * Wire contract between apps/web and the Socket.io gateway for HID input.
 *
 * Coordinate math is deliberately done client-side, exactly like PiKVM's own reference web
 * UI: only the browser knows the video canvas's actual rendered size and letterbox offset at
 * the moment of the event (it changes on every resize), so `x`/`y` here are already in
 * PiKVM's absolute HID space (-32768..32767, origin at screen centre) -- see
 * packages/shared/src/hid/mouse-math.ts, which apps/web calls before emitting this event.
 * The backend never recomputes or second-guesses this; it only checks who is allowed to
 * send it (see Session.controllerUserId) and applies the modifier/keymap remap for keys.
 */

export const KeyEventSchema = z.object({
  type: z.literal("key"),
  code: z.string(), // KeyboardEvent.code, e.g. "ControlLeft" -- never `.key`
  state: z.boolean(), // true = down, false = up
  ts: z.number(), // client-side performance.now() + timeOrigin, for latency measurement
});

export const MouseMoveEventSchema = z.object({
  type: z.literal("mouse_move"),
  x: z.number().int().min(-32768).max(32767), // already in PiKVM absolute HID space
  y: z.number().int().min(-32768).max(32767),
  ts: z.number(),
});

export const MouseButtonEventSchema = z.object({
  type: z.literal("mouse_button"),
  button: z.enum(["left", "middle", "right", "up", "down"]),
  state: z.boolean(),
  ts: z.number(),
});

export const MouseWheelEventSchema = z.object({
  type: z.literal("mouse_wheel"),
  deltaX: z.number(),
  deltaY: z.number(),
  ts: z.number(),
});

export const HidInputEventSchema = z.discriminatedUnion("type", [
  KeyEventSchema,
  MouseMoveEventSchema,
  MouseButtonEventSchema,
  MouseWheelEventSchema,
]);

export type HidInputEvent = z.infer<typeof HidInputEventSchema>;

export const PrintTextRequestSchema = z.object({
  sessionId: z.string().uuid(),
  text: z.string().max(1024),
});
export type PrintTextRequest = z.infer<typeof PrintTextRequestSchema>;
