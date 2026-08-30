import { TargetOs } from "../enums.js";

/**
 * Modifier keys as reported by `KeyboardEvent.code`. PiKVM (and every native HID target)
 * only understands physical codes, never `KeyboardEvent.key` -- see keyboard.ts docs.
 */
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
]);

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/**
 * PiKVM performs zero modifier translation: whatever `code` you send is the physical key
 * pressed on the emulated USB keyboard. That is correct when the operator's physical keyboard
 * and the target console run the same platform convention, but wrong across platforms:
 *
 *   - A Windows/Linux operator's "Ctrl" (code=ControlLeft) is the copy/paste/select-all modifier.
 *   - A macOS target's copy/paste/select-all modifier is "Cmd" (code=MetaLeft).
 *
 * Passing ControlLeft straight through to a macOS target does NOT trigger copy/paste; it
 * triggers whatever ctrl-chord is bound in the app (often nothing, or something unrelated).
 *
 * This function swaps Control<->Meta (both sides) whenever the operator's client platform and
 * the equipment's target platform disagree about which one is the "primary" modifier, and
 * leaves Alt/Shift untouched (Alt<->Option is a label difference only, not a semantic one --
 * both send the same physical AltLeft/AltRight code and the target OS interprets it correctly).
 *
 * This is a deliberate product feature: PiKVM itself does not do this, and the spec's
 * "operator uses a Mac in test, clinic runs Windows in production" split makes it necessary.
 */
export function remapModifierCode(code: string, clientOs: TargetOs, targetOs: TargetOs): string {
  const clientIsMac = clientOs === TargetOs.MACOS;
  const targetIsMac = targetOs === TargetOs.MACOS;

  if (clientIsMac === targetIsMac) {
    // Same convention on both ends (Mac<->Mac, or Windows/Linux<->Windows/Linux). No remap.
    return code;
  }

  switch (code) {
    case "ControlLeft":
      return "MetaLeft";
    case "ControlRight":
      return "MetaRight";
    case "MetaLeft":
      return "ControlLeft";
    case "MetaRight":
      return "ControlRight";
    default:
      return code;
  }
}

/**
 * pikvm/pikvm#819: some ISO/JIS keyboards (and the macOS DOM implementation for them) report
 * the wrong `code` for the backtick/section-sign key depending on `ev.key`. PiKVM's own web UI
 * carries this exact fix; without it, the key sent to the target is physically wrong.
 */
export function fixIsoBackquote(code: string, key: string): string {
  if (code === "IntlBackslash" && (key === "`" || key === "~")) {
    return "Backquote";
  }
  if (code === "Backquote" && (key === "\u00a7" || key === "\u00b1")) {
    return "IntlBackslash";
  }
  return code;
}

/**
 * pikvm/pikvm#375: on Windows, pressing AltGr fires a synthetic ControlLeft keydown
 * immediately before AltRight. Sent verbatim, the target sees a phantom Ctrl held down while
 * the operator is only pressing AltGr (needed for `@`, `#`, and on pt-BR ABNT2 for `/ ? °`).
 * PiKVM's own client delays ControlLeft by 50ms and cancels/fires it depending on what follows.
 *
 * The decision table below is a pure function of (code, state, hasPendingControlLeft) so it is
 * trivially unit-testable. The caller (apps/web's keyboard hook) owns the actual setTimeout and
 * feeds the result back in via `hasPendingControlLeft`.
 */
export type AltGrDecision =
  | { action: "suppress-and-schedule" } // ControlLeft down: hold it, start the 50ms timer
  | { action: "cancel-pending" } // AltRight followed, or Ctrl released before timer fired: drop it, no target-side effect
  | { action: "fire-pending-then-forward" } // a non-AltRight key arrived while Ctrl was pending: fire Ctrl now, then forward this event normally
  | { action: "forward" }; // unrelated event: forward unmodified

export function decideAltGrCtrl(
  code: string,
  state: boolean,
  hasPendingControlLeft: boolean
): AltGrDecision {
  if (state && code === "ControlLeft" && !hasPendingControlLeft) {
    return { action: "suppress-and-schedule" };
  }
  if (state && code === "AltRight" && hasPendingControlLeft) {
    return { action: "cancel-pending" };
  }
  if (!state && code === "ControlLeft" && hasPendingControlLeft) {
    return { action: "cancel-pending" };
  }
  if (hasPendingControlLeft && !(code === "ControlLeft" || code === "AltRight")) {
    return { action: "fire-pending-then-forward" };
  }
  return { action: "forward" };
}
