# PiKVM Integration Notes

Everything here was verified against PiKVM's own documentation and reference web UI source
(`pikvm/kvmd`'s `web/share/js/kvm/*.js`), not inferred. Where a fix mirrors a specific
upstream bug, the GitHub issue is named so it can be re-verified against future PiKVM
releases.

Every REST call in `PiKvmRestClient` (`packages/pikvm/src/rest-client.ts`) carries a 5-second
`AbortSignal.timeout`. This is not a stylistic choice: an unreachable device previously hung
these calls for however long the OS's own TCP retry behaviour takes (potentially over a
minute), on exactly the path (`releaseAll()` -> `/api/hid/reset`) meant to be the fast,
reliable safety net for stuck input. See `docs/architecture.md`'s "Every network call to
hardware needs a timeout" for the full story, including how it was actually found.

PiKVM ships a self-signed HTTPS cert by default (confirmed against a real PiKVM Mini: Node's
global `fetch` fails every request with `DEPTH_ZERO_SELF_SIGNED_CERT` otherwise).
`PiKvmHidClient`/`PiKvmMediaRelay` already relaxed this for their `ws` connections
(`rejectUnauthorized: false`); `PiKvmRestClient` now does the same for `fetch` via an
`undici` `Agent({ connect: { rejectUnauthorized: false } })` passed as `dispatcher` -- Node's
global `fetch` is undici under the hood and honours that option without switching away from
the global function (which is what let this stay a one-line change and kept the existing
`vi.fn()`-mocked `global.fetch` tests working unmodified).

`PiKvmRestClient.getInfo()` originally assumed `GET /api/info?fields=hid,hw` -- also wrong on
real hardware (kvmd 4.61): `/api/info` has no `hid` key at all, and `?fields=hid` itself gets
a `400 ValidatorError`. HID state lives at its own `GET /api/hid`, whose result shape is the
`hid` object callers expect, unwrapped. `getInfo()` now issues both requests
(`GET /api/hid` and `GET /api/info?fields=hw`) and merges them, so `PiKvmHealthPoller` and
anything else consuming `PiKvmInfo` never had to change.

## Authentication

`X-KVMD-User` / `X-KVMD-Passwd` headers. With PiKVM device-level 2FA enabled, the password is
the plain password with the current TOTP code concatenated directly, **no separator**
(`"foobar" + "123456"` -> `"foobar123456"`). A request made in the last second of the current
30s TOTP window can land just as the code rotates and get `403`; `@crop/pikvm`'s
`remainingTotpWindowMs` exists to let a caller defer such a request by a beat.

This is unrelated to the platform's own 2FA (mandatory for every RadLink user, see
`docs/architecture.md`) -- PiKVM device 2FA is optional and per-equipment.

## HID over `/api/ws?stream=1`

Persistent WebSocket, not REST, for anything at input frequency -- a REST call per event at
up to 60 events/second is a TLS+HTTP round trip each time. `stream=1` keeps PiKVM's video
streamer alive for as long as this connection is open, which conveniently means the media
relay always has frames ready by the time a browser connects to watch.

Wire shapes (exact, from `kvmd`'s `mouse.js`/`keyboard.js`):

```
{"event_type":"key",           "event":{"key":"KeyA","state":true,"finish":false}}
{"event_type":"mouse_move",    "event":{"to":{"x":-16384,"y":8192}}}      // signed 16-bit, origin at screen centre
{"event_type":"mouse_relative","event":{"delta":{"x":10,"y":-5},"squash":true}}
{"event_type":"mouse_button",  "event":{"button":"left","state":true}}
{"event_type":"mouse_wheel",   "event":{"delta":{"x":0,"y":-5}}}
```

### Incoming HID state: `event_type` is `"hid"`, not `"hid_state"`

`/api/ws?stream=1` is a multiplexed channel -- alongside HID it also pushes `gpio`, `atx`,
`msd`, `ocr`, `streamer`, and general `info` events, unprompted, as soon as the connection
opens. `PiKvmHidClient.handleMessage` only cares about two of these: `"loop"` (connection
ready) and the keyboard/mouse online+LED status, which a stock PiKVM Mini running kvmd 4.61
sends as `{"event_type":"hid","event":{...}}` -- confirmed by capturing the real event stream
from physical hardware. (`"hid_state"` was this codebase's original assumption and does not
appear anywhere in the actual stream; nothing in production consumed the `state` event yet,
so this was corrected before it became a silent dependency.)

### The stuck-key/button hazard

If a client disconnects mid-keypress, PiKVM has no timeout of its own -- the key stays
physically held on the target. This is the single most important safety property in this
codebase. Mitigations, all present:

- `PiKvmHidClient` (`packages/pikvm`) tracks every key/button it has sent as pressed and
  exposes `releaseAll()`, which releases all of them and then calls `POST /api/hid/reset`.
- `releaseAll()` runs on: session end, takeover (before reassigning control, not after --
  see `ExecuteTakeoverHandler`), the HID WebSocket's own `close` event, and a Socket.io
  gateway disconnect if the disconnecting user was the controller (`SessionsGateway.handleDisconnect`).
- `finish: true` on a key event tells PiKVM to release non-modifier keys immediately after
  pressing them -- useful on an unstable link, wrong for anything meant to be *held* (a
  continuously-scrolled arrow key, a drag). Left `false` in normal operation; `releaseAll()`
  is the actual safety net, not `finish`.
- `apps/web`'s `useHidInput` mirrors `pikvm/pikvm#1653`: a mouse button released outside the
  browser window never fires `mouseup`. Releasing everything on `mouseleave` if the tracked
  button state doesn't match avoids a stuck button for the rest of the session.

### Coordinates are computed client-side, not server-side

`x`/`y` in a `mouse_move` event are already in PiKVM's absolute HID space
(`-32768..32767`, origin at screen centre) by the time they reach the API. The conversion
(`@crop/shared`'s `toAbsoluteHidCoordinates`) happens in the browser, because only the
browser knows the video canvas's actual rendered size at the moment of the event -- it
changes on every window resize, and PiKVM's own web UI does the same conversion client-side
for the same reason. The backend only checks *who* is allowed to send the event; it never
recomputes the coordinates.

`useHidInput` also flushes any pending mouse-move before every button event
(`flushPendingMove()` inside `onMouseDown`) -- PiKVM's own client does this because a click
must land where the cursor actually is, not wherever it was at the last 16ms tick.

### Keyboard edge cases

| Case | Fix | Where |
|---|---|---|
| Wrong characters typed | Send `KeyboardEvent.code`, never `.key` | `useHidInput` |
| ISO/Mac backtick key reports the wrong `code` (`pikvm/pikvm#819`) | `fixIsoBackquote` | `@crop/shared` |
| Windows AltGr fires a phantom `ControlLeft` before `AltRight` (`pikvm/pikvm#375`) | Delay `ControlLeft` 50ms, cancel if `AltRight` follows | `decideAltGrCtrl` (`@crop/shared`), wired in `useHidInput` |
| macOS: releasing Meta never delivers keyup for other held keys | Release every locally-tracked pressed key when Meta releases | `useHidInput` |
| Browser eats Ctrl+Alt+Del, Alt+Tab, Cmd+Q | Not handled in this MVP -- PiKVM's own UI needs a dedicated "magic shortcut" composer for this; skipped as polish (see `docs/architecture.md`) |
| Accented text, patient names/IDs | `POST /api/hid/print?keymap=...`, not per-key events | `PrintTextHandler` |
| **Cross-platform Control/Cmd** (this project's macOS-operator / Windows-target scenario) | PiKVM does zero modifier translation -- swap `Control<->Meta` when the operator's and target's platform conventions disagree | `remapModifierCode` (`@crop/shared`), applied server-side in `ProcessHidInputHandler` (needs to know both the operator's platform, from the JWT, and the equipment's target platform) |
| First USB HID connect on a macOS target | Pops the Keyboard Setup Assistant. One-time; no code fix, just an operational note for whoever sets up the target machine |

## Video: Direct H.264 over WebSocket

`/api/media/ws`, exact handshake (from `kvmd`'s `stream_media.js`):

1. Connect, `binaryType = "arraybuffer"`.
2. Receive `{"event_type":"media","event":{"video":{"h264":{"profile_level_id":"..."}}}}`.
3. Codec string is `avc1.${profile_level_id}`.
4. Send `{"event_type":"start","event":{"type":"video","format":"h264"}}`.
5. Binary frames: 2-byte header. `header[0] === 1` is a video frame (`header[1]` = is-keyframe);
   `header[0] === 255` is a pong. Payload starts at offset 2.
6. Keepalive: send `Uint8Array([0])` every second; 5 missed pongs means the connection is dead.
7. `VideoDecoder.configure({codec, optimizeForLatency: true})` -- only ever on a keyframe.
8. Requires a secure context (HTTPS or `localhost`) for `VideoDecoder` to exist at all.

`MediaStreamServer` (API) relays these bytes verbatim in both directions and does not parse
them; `apps/web/src/hooks/use-media-stream.ts` is the client that actually speaks this
protocol, against `/stream` instead of PiKVM directly. Keeping the relay dumb means the two
can never drift apart -- there is only one place that understands this wire format now that
the relay doesn't, and it's the same code PiKVM's own users already validate daily.

WebRTC (PiKVM's default video mode) was considered and rejected for this platform:
it needs STUN/TURN and, per PiKVM's own docs, using a custom TURN server means abandoning
`kvmd-janus` for `kvmd-janus-static` with a hand-edited `janus.jcfg` -- real setup cost for a
30-day timeline, for a browser that was never going to be on the same network as PiKVM
anyway (see the trust-boundary discussion in `docs/architecture.md`).

## Deliberately unimplemented: ATX and MSD

`@crop/pikvm`'s `PiKvmRestClient` does not implement `/api/atx/*` or `/api/msd/*` at all --
not filtered by a permission check, simply absent from the client, so calling either is a
compile error, not a runtime authorization decision that could be misconfigured.

- **ATX (power control)**: a remote power-off mid-scan on an MRI/CT is a patient-safety
  incident, not a feature.
- **MSD (virtual USB mass storage)**: lets a remote client mount a drive on the clinical
  machine -- a direct PHI exfiltration path that has nothing to do with remote operation.

## Keymaps

36 layouts, enumerated in `@crop/shared`'s `PIKVM_KEYMAPS` (from PiKVM's
`GET /api/hid/keymaps`). Equipment stores its own `keymap` (default `en-us`; this platform's
seed data uses `pt-br` for the Brazilian production target), used only by
`POST /api/hid/print` for typed text -- individual keydown/keyup events carry a raw `code`
and need no keymap translation, since that translation happens on the target OS itself.
