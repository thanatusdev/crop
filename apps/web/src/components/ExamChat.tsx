import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatClinicTime, todayClinicDayString, type ExamMessageDto, type MessageShortcutDto } from "@crop/shared";
import { cn } from "cn";
import { Download, FileText, Paperclip, X } from "lucide-react";
import { ShortcutChips } from "./ShortcutChips.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Textarea } from "./ui/textarea.js";
import { Alert, AlertDescription } from "./ui/alert.js";
import { useAuthenticatedImage } from "../hooks/use-authenticated-image.js";
import { api } from "../lib/api-client.js";

/** Images and one document type -- mirrors `ALLOWED_ATTACHMENT_MIME_TYPES` in
 * `apps/api`'s `ChatController` exactly, so a file the browser will reject up front is never
 * even offered a round trip to find that out. Kept in sync by hand (no shared contract module
 * exports a mime allow-list today); if the server's list ever changes, this one must too. */
const ALLOWED_ATTACHMENT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One message's attachment, rendered as an inline thumbnail for an image or a
 * click-to-download chip for anything else (a PDF) -- both go through
 * `useAuthenticatedImage`/`api.getBlob` rather than a plain `<img src>`/`<a href>` because
 * the download route is authenticated (see `ChatController.getAttachment`'s own docstring),
 * and a bare `<img>` cannot attach an Authorization header. */
function ChatAttachment({ attachment }: { attachment: NonNullable<ExamMessageDto["attachment"]> }) {
  const { t } = useTranslation(["exam"]);
  const isImage = attachment.mimeType.startsWith("image/");
  const path = `/chat/messages/${attachment.messageId}/attachment`;
  const imageUrl = useAuthenticatedImage(isImage ? path : null);
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      const blob = await api.getBlob(path);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.filename;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  if (isImage) {
    return (
      <button type="button" className="mt-1.5 block max-w-40 overflow-hidden rounded-md border" onClick={() => void download()}>
        {imageUrl ? (
          <img src={imageUrl} alt={attachment.filename} className="block max-h-40 w-full object-cover" />
        ) : (
          <span className="block h-20 w-40 animate-pulse bg-secondary" aria-hidden="true" />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="mt-1.5 flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[12px] disabled:opacity-60"
      onClick={() => void download()}
      disabled={downloading}
    >
      <FileText className="size-3.5 flex-shrink-0" />
      <span className="truncate">{attachment.filename}</span>
      <span className="text-muted-foreground">({humanFileSize(attachment.sizeBytes)})</span>
      <Download className="size-3.5 flex-shrink-0" aria-label={t("exam:downloadAttachment")} />
    </button>
  );
}

/**
 * The exam-support chat panel: day picker + transcript + shortcut chips + composer, shared by
 * `ExamPage`'s left column and `NursingPage`'s right column -- the one chat surface both the
 * remote operator and the room's own nursing staff read and write, now that the room's chat is
 * an equipment-scoped socket room either side can join (see
 * `RT_EVENTS.JOIN_EQUIPMENT_CHAT`'s own docstring) rather than something only a session
 * participant could ever reach.
 *
 * Sending is asynchronous REST now (`POST /chat/messages`, optionally multipart with a file),
 * not a fire-and-forget socket emit -- the composer disables itself and surfaces a real error
 * if the request fails, rather than optimistically clearing a draft that the server ends up
 * rejecting. The transcript itself does not append optimistically either: the live socket
 * broadcast (`EXAM_MESSAGE_CREATED`, handled by the caller) is the single source of truth for
 * what actually made it into the room's history, exactly as it already was before sending
 * moved off the socket.
 */
export function ExamChat({
  messages,
  shortcuts,
  currentUserId,
  onSend,
  onCreateShortcut,
  creatingShortcut,
  createShortcutError,
  day,
  onDayChange,
  loadError,
}: {
  messages: readonly ExamMessageDto[];
  shortcuts: readonly MessageShortcutDto[];
  currentUserId: string | undefined;
  onSend: (body: string, file: File | null) => Promise<void>;
  onCreateShortcut: (input: { code: string; label: string; body: string }) => Promise<void>;
  creatingShortcut: boolean;
  createShortcutError: string | null;
  /** `YYYY-MM-DD`, the clinical day currently shown -- see `ChatController`'s own `date`
   * query param. */
  day: string;
  onDayChange: (day: string) => void;
  loadError?: string | null;
}) {
  const { t } = useTranslation(["exam"]);
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const today = todayClinicDayString();

  // Auto-scroll to the newest message -- a chat panel that silently grows past its own
  // scrollable card without following the conversation would leave the reader staring at
  // whatever was on screen when it started.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  function pickFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const picked = ev.target.files?.[0] ?? null;
    ev.target.value = "";
    if (!picked) return;
    if (!ALLOWED_ATTACHMENT_MIME_TYPES.includes(picked.type)) {
      setFileError(t("exam:attachmentTypeError"));
      return;
    }
    if (picked.size > MAX_ATTACHMENT_BYTES) {
      setFileError(t("exam:attachmentSizeError"));
      return;
    }
    setFileError(null);
    setFile(picked);
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    const body = draft.trim();
    if (!body && !file) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend(body, file);
      setDraft("");
      setFile(null);
    } catch {
      setSendError(t("exam:sendError"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground" htmlFor="exam-chat-day">
          {t("exam:historyLabel")}
        </label>
        <div className="flex items-center gap-1.5">
          <Input id="exam-chat-day" type="date" max={today} value={day} onChange={(e) => onDayChange(e.target.value)} className="h-8 w-auto text-[12px]" />
          {day !== today && (
            <Button type="button" variant="outline" size="sm" onClick={() => onDayChange(today)}>
              {t("exam:historyToday")}
            </Button>
          )}
        </div>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      <div
        className="flex flex-1 min-h-0 flex-col gap-2.5 overflow-y-auto rounded-md border bg-background p-3"
        ref={listRef}
        role="log"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t("exam:chatEmpty")}</p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "flex max-w-[85%] flex-col gap-0.5 rounded-xl px-3 py-2 text-[13px] shadow-sm",
                message.authorUserId === currentUserId ? "self-end bg-accent" : "self-start bg-secondary"
              )}
            >
              <div className="mb-0.5 flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
                <strong className="text-foreground">{message.authorName ?? t("exam:unknownAuthor")}</strong>
                <span>{formatClinicTime(message.createdAt)}</span>
              </div>
              {message.body && <div className="break-words whitespace-pre-wrap">{message.body}</div>}
              {message.attachment && <ChatAttachment attachment={message.attachment} />}
            </div>
          ))
        )}
      </div>

      <ShortcutChips
        shortcuts={shortcuts}
        onInsert={(body) => setDraft((prev) => (prev ? `${prev} ${body}` : body))}
        onCreate={onCreateShortcut}
        creating={creatingShortcut}
        createError={createShortcutError}
      />

      {sendError && (
        <Alert variant="destructive">
          <AlertDescription>{sendError}</AlertDescription>
        </Alert>
      )}
      {fileError && (
        <Alert variant="destructive">
          <AlertDescription>{fileError}</AlertDescription>
        </Alert>
      )}

      {file && (
        <div className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[12px]">
          <FileText className="size-3.5 flex-shrink-0" />
          <span className="truncate">{file.name}</span>
          <span className="text-muted-foreground">({humanFileSize(file.size)})</span>
          <button
            type="button"
            className="ml-auto text-muted-foreground hover:text-foreground"
            onClick={() => setFile(null)}
            aria-label={t("exam:removeAttachment")}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <form className="flex items-end gap-2" onSubmit={submit}>
        <label className="sr-only" htmlFor="exam-chat-input">
          {t("exam:chatInputLabel")}
        </label>
        <Textarea
          id="exam-chat-input"
          rows={2}
          maxLength={2000}
          placeholder={t("exam:chatInputPlaceholder")}
          value={draft}
          disabled={sending}
          className="min-h-20 min-w-0 flex-1"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(ev) => {
            // Enter sends, Shift+Enter inserts a newline -- the same convention every other
            // chat client uses, so this behaves as expected without an explicit affordance.
            if (ev.key === "Enter" && !ev.shiftKey) {
              ev.preventDefault();
              void submit(ev as unknown as React.FormEvent);
            }
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_ATTACHMENT_MIME_TYPES.join(",")}
          className="sr-only"
          onChange={pickFile}
          aria-label={t("exam:attachFile")}
        />
        {/* Stacked, not inline with the textarea -- attach sits directly above send (both
            flex-none, so neither steals the textarea's width) rather than the three of them
            splitting one row three ways, which is what was squeezing the message field down
            to a fraction of the panel's own width. `min-h-20` on the textarea above matches
            this column's real height (two size="icon" is actually a 36px icon button + an
            h-9 send button + the gap between them = 80px) so the field stays flush with it
            instead of leaving one side stranded short. */}
        <div className="flex flex-none flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="self-end"
            disabled={sending}
            onClick={() => fileInputRef.current?.click()}
            aria-label={t("exam:attachFile")}
          >
            <Paperclip />
          </Button>
          <Button type="submit" disabled={sending || (!draft.trim() && !file)}>
            {sending ? t("exam:sending") : t("exam:send")}
          </Button>
        </div>
      </form>
    </div>
  );
}
