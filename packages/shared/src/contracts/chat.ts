import { z } from "zod";

/**
 * The exam-support chat -- the real, persisted clinic<->operator text channel this codebase's
 * own "not intentionally built" list (docs/architecture.md) used to name as missing, replacing
 * two prior nursing-prototype passes that both dropped it for the identical, correct reason at
 * the time: no messaging transport existed anywhere in this codebase. `SessionPage`'s own
 * `PRINT_TEXT` remains untouched and is not superseded by this -- that channel types characters
 * directly into the remote equipment's own focused field over HID; this one is a conversation
 * between people, stored durably, never forwarded to PiKVM at all.
 *
 * Tied to the *equipment* (the room), not to any one session: `equipmentId` is what a message
 * is filtered by, and the channel outlives whichever session happens to be active when it was
 * sent -- a note like "scanner calibrated" left before an exam starts should still be visible
 * to whoever joins next, and (since the equipment-room transport replaced the old
 * session-room-only one -- see `RT_EVENTS.JOIN_EQUIPMENT_CHAT`'s own docstring) to nursing as
 * well, which never joins a session at all. `queueEntryId` is stamped opportunistically from
 * whatever the room's *current* patient is at send time (see `SendExamMessageHandler`), so a
 * message can later be filtered to one exam's own transcript without that being the only way
 * to reach it.
 */
export const ExamMessageAttachmentSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  // Not a raw file path -- an opaque id the download route resolves back through the owning
  // message row (see `GET /chat/messages/:id/attachment`'s own docstring for why the storage
  // path itself is never handed to a client, the same "never take a path from the URL"
  // discipline `SessionsController`'s snapshot-image route already established).
  messageId: z.string().uuid(),
});
export type ExamMessageAttachmentDto = z.infer<typeof ExamMessageAttachmentSchema>;

export const ExamMessageSchema = z.object({
  id: z.string().uuid(),
  equipmentId: z.string().uuid(),
  queueEntryId: z.string().uuid().nullable(),
  authorUserId: z.string().uuid(),
  // Resolved at read/broadcast time (see SessionParticipantNameService's own precedent for
  // "resolve a display name at the presentation boundary, never store it") -- null only for
  // the same edge case that precedent already documents: an author account since deleted, which
  // this codebase's own "never hard-delete a user" policy makes purely defensive.
  authorName: z.string().nullable(),
  body: z.string(),
  attachment: ExamMessageAttachmentSchema.nullable(),
  createdAt: z.string(),
});
export type ExamMessageDto = z.infer<typeof ExamMessageSchema>;

/**
 * `POST /chat/messages`'s payload -- REST, not the socket, unlike the rest of this app's
 * real-time control plane (`HID_INPUT`/`PRINT_TEXT`/`TAKEOVER_REQUEST`, all WebSocket-only).
 * Two things forced that split for this one write specifically: an attachment cannot ride the
 * same low-latency socket that carries 60/sec HID coordinates without either base64-inflating
 * a binary payload through JSON or growing a second, parallel binary framing just for chat --
 * both worse than one multipart REST call; and nursing, which sends and receives this chat but
 * never joins a session (see `ExamMessageSchema`'s own docstring), would otherwise need a
 * session-shaped socket context purely to satisfy a write path that has nothing to do with
 * sessions at all. The "one entry point for a write that broadcasts live" rule this used to
 * be the exception to is preserved a different way here: `SendExamMessageHandler` still is the
 * only place a message is ever created, and creating one still always publishes
 * `ExamMessageSentEvent`, which is still the only thing that ever emits
 * `RT_EVENTS.EXAM_MESSAGE_CREATED` -- there is exactly one write path and exactly one broadcast
 * path, they are simply no longer the same transport.
 *
 * `equipmentId` is sent explicitly (unlike the old socket version, which read it off
 * `data.session`) because a REST call has no session-join context to read it from at all --
 * the handler re-derives the same tenant + agreement-scope check `ListExamMessagesHandler`
 * already applies to reads, rather than trusting a client-supplied id.
 */
export const SendExamMessageRequestSchema = z.object({
  equipmentId: z.string().uuid(),
  body: z.string().max(2000),
});
export type SendExamMessageRequest = z.infer<typeof SendExamMessageRequestSchema>;

/**
 * A canned quick-reply, scoped to one clinic tenant (`tenantId` is whichever clinic was active
 * when it was created -- for a contracted operator that is the clinic's own tenant, post-switch,
 * never their home tenant). Deliberately per-clinic, not per-operator-company: these are the
 * clinic's own standard phrases ("contrast administered", "patient positioned supine"), shared
 * by whichever company is currently contracted to run the room, not a personal canned-reply list
 * that would need re-creating per operator.
 */
export const MessageShortcutSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  label: z.string(),
  body: z.string(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type MessageShortcutDto = z.infer<typeof MessageShortcutSchema>;

/** `POST /chat/shortcuts` -- `code` is the short chip label shown on the button (`"CONT"`,
 * `"PL"`); `label` is a longer human-readable name for management screens; `body` is the actual
 * text a click inserts into the composer. Bounded the same way `SendExamMessageRequestSchema`
 * is, for the same reason: this ends up as chat content too. */
export const CreateMessageShortcutRequestSchema = z.object({
  code: z.string().min(1).max(12),
  label: z.string().min(1).max(80),
  body: z.string().min(1).max(2000),
});
export type CreateMessageShortcutRequest = z.infer<typeof CreateMessageShortcutRequestSchema>;

/**
 * `JOIN_EQUIPMENT_CHAT`'s payload (client -> server): joins the socket to this equipment's own
 * chat room (`equipment:<id>`, see `SessionsGateway`'s own comment on the room-naming split
 * from `session:<id>`). Replaces the old design where a chat message could only be sent/heard
 * by a socket that had already joined a *session* -- which nursing, never a session
 * participant, could never do at all. Deliberately its own join, not a side effect of
 * `JOIN_SESSION`: the equipment's chat outlives any one session (see `ExamMessageSchema`'s own
 * docstring), and a nurse's socket has no session to join in the first place.
 */
export const JoinEquipmentChatRequestSchema = z.object({
  equipmentId: z.string().uuid(),
});
export type JoinEquipmentChatRequest = z.infer<typeof JoinEquipmentChatRequestSchema>;
