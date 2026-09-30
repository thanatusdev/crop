import { useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";
import {
  RT_EVENTS,
  decideAltGrCtrl,
  fixIsoBackquote,
  toAbsoluteHidCoordinates,
  toScrollStep,
  type HidInputEvent,
} from "@crop/shared";

const ALTGR_DELAY_MS = 50;
const SCROLL_RATE = 5;

type MouseButtonName = "left" | "middle" | "right";

function buttonNameFor(button: number): MouseButtonName | null {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return null;
  }
}

/**
 * Captures keyboard/mouse input on the console and forwards it over the session socket.
 *
 * Modifier remapping for cross-platform operation (Control<->Meta) is deliberately NOT done
 * here -- it happens server-side in ProcessHidInputHandler, which knows both the operator's
 * platform (from the JWT) and the equipment's target platform. This hook only fixes up
 * browser-side capture quirks that have nothing to do with the target: the AltGr phantom
 * Ctrl on Windows, the ISO backquote misreport, and macOS's missing keyup events after a
 * Cmd release. See docs/pikvm-integration.md for all three.
 */
export function useHidInput(params: {
  socket: Socket | null;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
}) {
  const { socket, canvasRef, containerRef, enabled } = params;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !socket) return;

    const pressedKeys = new Set<string>();
    const pressedButtons = new Set<MouseButtonName>();
    let pendingMove: { x: number; y: number } | null = null;
    let altGrPending = false;
    let altGrTimer: ReturnType<typeof setTimeout> | null = null;

    const send = (event: HidInputEvent) => {
      if (!enabledRef.current) return;
      socket.emit(RT_EVENTS.HID_INPUT, event);
    };

    const sendKey = (code: string, state: boolean) => {
      if (state) pressedKeys.add(code);
      else pressedKeys.delete(code);
      send({ type: "key", code, state, ts: performance.now() });
    };

    const flushPendingMove = () => {
      if (!pendingMove) return;
      send({ type: "mouse_move", x: pendingMove.x, y: pendingMove.y, ts: performance.now() });
      pendingMove = null;
    };

    const handleKeyEvent = (rawCode: string, key: string, state: boolean) => {
      const code = fixIsoBackquote(rawCode, key);

      const decision = decideAltGrCtrl(code, state, altGrPending);
      switch (decision.action) {
        case "suppress-and-schedule":
          altGrPending = true;
          altGrTimer = setTimeout(() => {
            altGrPending = false;
            sendKey("ControlLeft", true);
          }, ALTGR_DELAY_MS);
          return;
        case "cancel-pending":
          if (altGrTimer) clearTimeout(altGrTimer);
          altGrPending = false;
          if (code !== "AltRight") return; // Ctrl released before the timer fired: nothing was ever sent
          break; // real AltGr chord: fall through and forward this AltRight normally
        case "fire-pending-then-forward":
          if (altGrTimer) clearTimeout(altGrTimer);
          altGrPending = false;
          sendKey("ControlLeft", true);
          break;
        case "forward":
          break;
      }

      // macOS quirk: releasing Meta never delivers keyup for keys pressed while it was held.
      // Compensate by releasing everything we believe is still down whenever Meta is released.
      if (!state && (code === "MetaLeft" || code === "MetaRight")) {
        sendKey(code, false);
        for (const stuckCode of [...pressedKeys]) {
          if (stuckCode !== code) sendKey(stuckCode, false);
        }
        return;
      }

      sendKey(code, state);
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.repeat) return; // let the target OS handle its own auto-repeat
      ev.preventDefault();
      handleKeyEvent(ev.code, ev.key, true);
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      ev.preventDefault();
      handleKeyEvent(ev.code, ev.key, false);
    };

    const onMouseMove = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      // No letterboxing in this layout: the canvas's CSS box always matches its intrinsic
      // aspect ratio (width:100%, height:auto), so the geometry offset is always zero.
      pendingMove = toAbsoluteHidCoordinates(
        { x: ev.clientX - rect.left, y: ev.clientY - rect.top },
        { x: 0, y: 0, width: rect.width, height: rect.height }
      );
    };

    const onMouseDown = (ev: MouseEvent) => {
      // `preventDefault()` on mousedown is necessary to stop the browser's own text
      // selection/drag-start behaviour over the canvas, but Chromium-based browsers (Arc,
      // Chrome, Edge) also skip their default click-to-focus step whenever mousedown's
      // default action is prevented -- so without the explicit `focus()` below, this
      // container never actually receives focus on click, and keydown/keyup (registered on
      // it, not on window) never fire at all. Confirmed against a real session: mouse input
      // worked, keyboard silently did nothing, with no error anywhere to point at this.
      ev.preventDefault();
      container.focus();
      const button = buttonNameFor(ev.button);
      if (!button) return;
      flushPendingMove(); // the click must land where the cursor actually is, not a stale position
      pressedButtons.add(button);
      send({ type: "mouse_button", button, state: true, ts: performance.now() });
    };

    const onMouseUp = (ev: MouseEvent) => {
      ev.preventDefault();
      const button = buttonNameFor(ev.button);
      if (!button) return;
      pressedButtons.delete(button);
      send({ type: "mouse_button", button, state: false, ts: performance.now() });
    };

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const deltaX = toScrollStep(ev.deltaX, SCROLL_RATE, false);
      const deltaY = toScrollStep(ev.deltaY, SCROLL_RATE, false);
      if (deltaX || deltaY) send({ type: "mouse_wheel", deltaX, deltaY, ts: performance.now() });
    };

    const onContextMenu = (ev: MouseEvent) => ev.preventDefault();

    // pikvm/pikvm#1653: a button released outside the window never fires mouseup here.
    // Releasing everything on re-entry (if the physical button state changed) avoids a stuck
    // "button held" state for the rest of the session.
    const onMouseLeave = () => {
      for (const button of pressedButtons) {
        send({ type: "mouse_button", button, state: false, ts: performance.now() });
      }
      pressedButtons.clear();
    };

    const flushTimer = setInterval(flushPendingMove, 16);

    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("keyup", onKeyUp);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("mouseleave", onMouseLeave);

    return () => {
      clearInterval(flushTimer);
      if (altGrTimer) clearTimeout(altGrTimer);
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("mouseleave", onMouseLeave);
    };
    // Deliberately `canvasRef.current`/`containerRef.current`, not the ref objects
    // themselves: SessionPage creates the Socket.io connection (fast, synchronous) before
    // its session/equipment REST fetch resolves (a real network round trip), and renders no
    // canvas/console-box at all until both are loaded. That means this effect's first run
    // sees `canvasRef.current`/`containerRef.current` as null, bails out via the early
    // `return` above, and -- since ref *objects* never change identity -- would otherwise
    // never run again once the console box actually mounts, permanently no-op-ing every
    // keyboard/mouse listener with no error anywhere. Depending on the dereferenced values
    // instead means this effect correctly re-runs on the next render after they're
    // populated (refs attach during commit, just before dependencies are diffed for the
    // following render). Confirmed against a live session: video worked throughout (
    // useMediaStream reads canvasRef.current fresh inside its async frame handler instead
    // of capturing it once), while zero real input events -- of any kind -- ever reached
    // the server; only a directly-injected test event did.
  }, [socket, canvasRef.current, containerRef.current]);
}
