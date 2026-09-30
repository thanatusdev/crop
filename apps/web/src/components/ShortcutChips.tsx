import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MessageShortcutDto } from "@crop/shared";
import { Plus } from "lucide-react";
import { Modal } from "./Modal.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Textarea } from "./ui/textarea.js";
import { Alert, AlertDescription } from "./ui/alert.js";

/**
 * Quick-reply chips for `ExamChat`'s composer -- real, persisted, per-clinic phrases (see
 * `MessageShortcutSchema`'s own docstring), not the RadLink mock's free-text "+ Adicionar Tag"
 * observation chips: this codebase prefers a closed, administrable set over an open typed-string
 * taxonomy, the same house rule `NursingPage`'s own "not reproduced" table already states for
 * that mock's tag chips. Clicking a chip inserts its `body` into the composer rather than
 * sending immediately -- the operator can still edit before sending, matching how the RadLink
 * mock's own macro buttons behave (a canned starting point, not a one-tap send).
 */
export function ShortcutChips({
  shortcuts,
  onInsert,
  onCreate,
  creating,
  createError,
}: {
  shortcuts: readonly MessageShortcutDto[];
  onInsert: (body: string) => void;
  onCreate: (input: { code: string; label: string; body: string }) => Promise<void>;
  creating: boolean;
  createError: string | null;
}) {
  const { t } = useTranslation(["exam"]);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [body, setBody] = useState("");
  const triggerRef = useRef<HTMLElement | null>(null);

  function openModal(ev: React.MouseEvent<HTMLButtonElement>) {
    triggerRef.current = ev.currentTarget;
    setCode("");
    setLabel("");
    setBody("");
    setOpen(true);
  }

  async function submit() {
    if (!code.trim() || !label.trim() || !body.trim()) return;
    await onCreate({ code: code.trim(), label: label.trim(), body: body.trim() });
    setOpen(false);
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {shortcuts.map((shortcut) => (
        <button
          key={shortcut.id}
          type="button"
          className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-semibold text-secondary-foreground"
          title={shortcut.label}
          onClick={() => onInsert(shortcut.body)}
        >
          {shortcut.code}
        </button>
      ))}
      <button
        type="button"
        className="flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs font-semibold text-muted-foreground"
        onClick={openModal}
      >
        <Plus className="size-3" /> {t("exam:createShortcut")}
      </button>

      {open && (
        <Modal title={t("exam:createShortcutTitle")} onClose={() => setOpen(false)} returnFocusTo={triggerRef.current}>
          {createError && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{createError}</AlertDescription>
            </Alert>
          )}
          <div className="mb-3.5 flex flex-col gap-1.5">
            <Label htmlFor="shortcut-code">{t("exam:shortcutCodeLabel")}</Label>
            <Input id="shortcut-code" value={code} maxLength={12} onChange={(e) => setCode(e.target.value)} autoFocus />
          </div>
          <div className="mb-3.5 flex flex-col gap-1.5">
            <Label htmlFor="shortcut-label">{t("exam:shortcutLabelLabel")}</Label>
            <Input id="shortcut-label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="mb-3.5 flex flex-col gap-1.5">
            <Label htmlFor="shortcut-body">{t("exam:shortcutBodyLabel")}</Label>
            <Textarea id="shortcut-body" rows={3} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="mt-3 flex items-center gap-2.5">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={creating}>
              {t("exam:cancel")}
            </Button>
            <Button onClick={() => void submit()} disabled={creating || !code.trim() || !label.trim() || !body.trim()}>
              {creating ? t("exam:saving") : t("exam:save")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
