import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog.js";

/**
 * Every modal/dialog in this app, on top of shadcn/ui's `Dialog` (Radix) rather than the
 * hand-rolled implementation this replaces. That implementation was correct on paper --
 * `role="dialog"`, `aria-labelledby`, a manual Tab/Shift+Tab focus trap, Escape-to-close,
 * focus-on-open, focus-return-on-close -- but had a real, user-facing bug: its focus-trap
 * `useEffect` depended on `[onClose, returnFocusTo]`, and every call site passed `onClose`
 * as an inline arrow (`onClose={() => setOpen(false)}`), which gets a new identity on every
 * render. Typing a single character into any field inside any of these 9 modals re-rendered
 * the owning page, which re-created `onClose`, which re-ran the effect: the *cleanup*
 * fired first (`previouslyFocused.current?.focus()`, yanking focus to the trigger button
 * outside the dialog), then the effect body re-ran (`dialogRef.current?.focus()`, parking
 * focus back on the dialog's outer container) -- so every keystroke visibly threw focus out
 * of the input and back onto the dialog frame. Radix's `Dialog.Content` traps and manages
 * focus itself, keyed to mount/unmount of the *content*, never to a prop's identity, so this
 * class of bug cannot recur here regardless of how an owning page re-renders.
 *
 * Kept identical for every call site: `title`, `onClose`, `children`. `returnFocusTo` is
 * kept for the one real edge case it exists for (see its own docstring below) -- everything
 * else Radix now does automatically that the old implementation had to do by hand.
 */
export function Modal({
  title,
  onClose,
  returnFocusTo,
  children,
}: {
  title: string;
  onClose: () => void;
  /**
   * Element to return focus to on close. Omit it and Radix's own default (focus whatever
   * was focused when the dialog opened) is correct for a plain "click a button, modal
   * opens" flow. Still needed for a trigger that also disables itself while its own action
   * is pending (`disabled={busy}`, the pattern this app's submit buttons use): disabling
   * the currently-focused element makes the browser blur it to `<body>` immediately, before
   * the dialog even mounts, so by the time Radix captures "what was focused on open" it's
   * already `document.body`, not the real trigger -- Radix's own default would then
   * faithfully restore focus to `body` too. Callers with that pattern must capture
   * `document.activeElement` themselves, synchronously in the click handler, before setting
   * the state that disables the button -- see `RecoveryPage`'s `RequestTab`.
   */
  returnFocusTo?: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Radix calls this for every way a dialog can close (Escape, overlay click, the
        // built-in X button) -- one callback covers what the old implementation needed a
        // manual keydown listener and a manual backdrop onClick to cover separately.
        if (!open) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (!returnFocusTo) return; // let Radix's own default run
          event.preventDefault();
          returnFocusTo.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
