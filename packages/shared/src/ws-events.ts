/**
 * Socket.io event names, centralised so the gateway (apps/api) and the client (apps/web)
 * cannot drift apart silently -- a typo in a string literal on either side would otherwise
 * fail at runtime with no type error.
 */
export const RT_EVENTS = {
  // client -> server
  HID_INPUT: "hid:input",
  PRINT_TEXT: "hid:print",
  TAKEOVER_REQUEST: "session:takeover:request",
  LATENCY_PING: "latency:ping",
  JOIN_SESSION: "session:join",

  // server -> client
  CONTROLLER_CHANGED: "session:controller_changed",
  SESSION_STATE: "session:state",
  SESSION_ENDED: "session:ended",
  LATENCY_PONG: "latency:pong",
  QUEUE_UPDATED: "queue:updated",
  EQUIPMENT_STATUS_CHANGED: "equipment:status_changed",
  ERROR: "error",
} as const;

export type RtEventName = (typeof RT_EVENTS)[keyof typeof RT_EVENTS];
