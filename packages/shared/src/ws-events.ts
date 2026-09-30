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
  RETURN_CONTROL_REQUEST: "session:return_control:request",
  LATENCY_PING: "latency:ping",
  JOIN_SESSION: "session:join",
  // Joins the socket to one equipment's own chat room (`equipment:<id>`) -- separate from
  // `JOIN_SESSION`'s `session:<id>` room because the exam-support chat is scoped to the room,
  // not to any one session (see `ExamMessageSchema`'s own docstring), and because nursing,
  // which sends and receives this chat, never joins a session at all. Sending itself moved to
  // `POST /chat/messages` (see `SendExamMessageRequestSchema`'s own docstring for why) -- this
  // event exists purely to receive the live `EXAM_MESSAGE_CREATED` broadcast, the same "read
  // is a room membership, write is elsewhere" split `JOIN_SESSION` already has relative to
  // `HID_INPUT`/`PRINT_TEXT`.
  JOIN_EQUIPMENT_CHAT: "chat:equipment:join",

  // server -> client
  CONTROLLER_CHANGED: "session:controller_changed",
  SESSION_STATE: "session:state",
  SESSION_ENDED: "session:ended",
  LATENCY_PONG: "latency:pong",
  QUEUE_UPDATED: "queue:updated",
  EQUIPMENT_STATUS_CHANGED: "equipment:status_changed",
  PATIENT_PREPARATION_UPDATED: "queue:preparation_updated",
  // Broadcast to `equipment:<id>` (not `session:<id>`) by
  // `BroadcastExamMessageHandler` after `POST /chat/messages` persists a message -- see that
  // handler's own docstring.
  EXAM_MESSAGE_CREATED: "exam:message:created",
  ERROR: "error",
} as const;

export type RtEventName = (typeof RT_EVENTS)[keyof typeof RT_EVENTS];
