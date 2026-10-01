import { useRef, useState } from "react";
import { CloudUpload } from "lucide-react";
import { cn } from "cn";
import { Button } from "./ui/button.js";

/**
 * A drag-and-drop file picker. The outer box is deliberately *not* `role="button"` --
 * axe's own `nested-interactive` rule is right that a negative `tabIndex` on the input
 * inside it does not make that input invisible to assistive tech (only to Tab order), so
 * wrapping a real `<input type="file">` in an element that itself claims an interactive
 * role is a genuine violation, not a false positive. The fix is the same shape `ExamChat`'s
 * own Paperclip control already uses: exactly one real, properly-exposed interactive
 * control (the "Procurar no Terminal Local" `<Button>`), which `.click()`s a hidden sibling
 * input via a ref -- not two overlapping ones.
 *
 * Drag-and-drop stays mouse/pointer-only, which is what it already is in every browser (there
 * is no keyboard equivalent of "drag a file" to begin with) -- the outer box's own `onClick`
 * is a convenience for a sighted mouse user (click anywhere in the box, not just the button),
 * not a second accessible entry point standing in for one, since the Button alone already
 * covers every keyboard/screen-reader path to the exact same file picker.
 */
export function FileDropzone({
  accept,
  disabled = false,
  busy = false,
  onFileSelected,
  label,
  hint,
  browseLabel,
}: {
  accept: string;
  disabled?: boolean;
  /** True while a previously selected file is still uploading -- same disabled *appearance*
   * as `disabled`, but a distinct reason worth telling the two apart for (e.g. a busy
   * spinner vs. a locked-form explanation). */
  busy?: boolean;
  onFileSelected: (file: File) => void;
  label: string;
  hint: string;
  browseLabel: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const inactive = disabled || busy;

  function openPicker() {
    if (!inactive) inputRef.current?.click();
  }

  function handleDrop(ev: React.DragEvent<HTMLDivElement>) {
    ev.preventDefault();
    setIsDraggingOver(false);
    if (inactive) return;
    const dropped = ev.dataTransfer.files[0];
    if (dropped) onFileSelected(dropped);
  }

  function handlePick(ev: React.ChangeEvent<HTMLInputElement>) {
    const picked = ev.target.files?.[0] ?? null;
    ev.target.value = ""; // reset so re-picking the same file still fires onChange
    if (picked) onFileSelected(picked);
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors",
        inactive ? "opacity-60" : "cursor-pointer hover:border-primary/50",
        isDraggingOver && !inactive && "border-primary bg-accent/40"
      )}
      onClick={openPicker}
      onDragOver={(ev) => {
        ev.preventDefault();
        if (!inactive) setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={handleDrop}
    >
      <CloudUpload aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {/* The one real, keyboard/screen-reader-reachable entry point -- stopPropagation isn't
          needed (there's nothing left above it with its own click semantics to double-fire),
          but openPicker() is itself a no-op double-call-safe (just re-focuses/re-clicks the
          same hidden input), so leaving the surrounding div's onClick in place is harmless. */}
      <Button type="button" variant="outline" size="sm" disabled={inactive} onClick={openPicker}>
        {browseLabel}
      </Button>
      <input ref={inputRef} type="file" accept={accept} className="sr-only" disabled={inactive} onChange={handlePick} aria-label={label} />
    </div>
  );
}
