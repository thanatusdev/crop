import { useTranslation } from "react-i18next";
import { formatClinicTime, type QueueEntryDto } from "@crop/shared";
import { cn } from "cn";
import { User } from "lucide-react";
import { Badge } from "./ui/badge.js";
import { queueCardChipOf } from "../lib/queue-display.js";

/**
 * A read-only rail of the room's own queue -- `ExamPage`'s top rail (non-vertical, the
 * default) and its own pre-session "start the next exam" prompt (`vertical`). Deliberately
 * not the same component as `NursingPage`'s inline list: that one is reorderable (native
 * drag-and-drop, move buttons, a dirty/confirm draft) because reordering the room's priority
 * is the nurse's own job; the remote operator driving the equipment has no business changing
 * that order, so this is the same `queueCardChipOf` chip logic with every write affordance
 * removed -- select-to-view-patient-info is this component's one interaction.
 *
 * Non-vertical rendering is a single compact row per patient (icon, name, exam · time, status
 * chip, all on one line, with a colored left accent on the selected card) -- the RadLink
 * mock's own "FILA DO SCANNER" strip shape. This replaced an earlier, taller stacked-field
 * card (rank line, name line, exam line, time line, chip line, each its own row) that was
 * needlessly tall for a rail meant to sit above the console as a slim strip, not compete with
 * it for vertical space. `vertical` (the pre-session prompt's own use) keeps its own taller,
 * stacked-field card -- that one has a whole page to itself, not a slim strip's worth of
 * height, so the extra room costs nothing there.
 */
export function QueueStrip({
  queue,
  selectedId,
  onSelect,
  vertical = false,
}: {
  queue: readonly QueueEntryDto[];
  selectedId: string | null;
  onSelect: (entry: QueueEntryDto) => void;
  vertical?: boolean;
}) {
  const { t } = useTranslation(["nursing", "exam"]);

  if (queue.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("exam:queueEmpty")}</p>;
  }

  if (!vertical) {
    return (
      <ul className="m-0 flex list-none gap-2 overflow-x-auto p-0.5">
        {queue.map((entry) => {
          const chip = queueCardChipOf(entry);
          const selected = selectedId === entry.id;
          return (
            <li
              key={entry.id}
              className={cn(
                "flex-none rounded-md border-y border-r border-l-4 bg-card",
                selected ? "border-l-primary bg-accent" : "border-l-transparent border-border"
              )}
            >
              <button
                type="button"
                className="flex items-center gap-2 px-2.5 py-1.5 text-left"
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(entry)}
              >
                <User className="size-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex flex-col leading-tight">
                  <span className="text-[13px] font-semibold whitespace-nowrap">{entry.patientFirstName}</span>
                  <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                    {[entry.examDescription, entry.scheduledAt ? formatClinicTime(entry.scheduledAt) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <Badge className={cn("ml-1 flex-shrink-0 border-transparent px-1.5 py-0 text-[10px] whitespace-nowrap", chip.badgeClass)}>
                  {t(chip.labelKey)}
                </Badge>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <ul className="m-0 flex max-h-90 list-none flex-col gap-2.5 overflow-x-visible overflow-y-auto p-0.5">
      {queue.map((entry, index) => {
        const chip = queueCardChipOf(entry);
        const selected = selectedId === entry.id;
        return (
          <li
            key={entry.id}
            className={cn("flex flex-none flex-col gap-1.5 rounded-[10px] border border-border p-2.5", selected && "border-primary bg-accent")}
          >
            <button
              type="button"
              className="flex w-full flex-col items-start gap-1 text-left"
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(entry)}
            >
              <span className="text-xs font-bold text-muted-foreground">{t("nursing:cardRank", { position: index + 1 })}</span>
              <span className="text-[15px] font-semibold">{entry.patientFirstName}</span>
              {entry.examDescription && <span className="text-[13px] text-muted-foreground">{entry.examDescription}</span>}
              {entry.scheduledAt && <span className="text-[13px] text-muted-foreground">{formatClinicTime(entry.scheduledAt)}</span>}
              <Badge className={cn("border-transparent", chip.badgeClass)}>{t(chip.labelKey)}</Badge>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
