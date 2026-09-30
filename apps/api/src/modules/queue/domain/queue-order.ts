import { QueueStatus } from "@crop/shared";
import type { QueueEntry } from "./queue-entry.entity.js";

export interface QueueReorderAssignment {
  id: string;
  position: number;
}

export type QueueReorderPlan =
  | { ok: true; noop: true }
  | { ok: true; noop: false; assignments: readonly QueueReorderAssignment[] }
  // The nurse dragged/arrowed a card that has since left WAITING (an operator started or
  // ended its session, or someone cancelled it) out from under her -- distinct from
  // STALE_SET because it points at *which* patient moved, not just "your view is old".
  | { ok: false; reason: "INCLUDES_NON_WAITING" }
  // orderedIds isn't exactly the room's current WAITING set (missing an id, or one that was
  // never in it) -- a plain stale-view mismatch, e.g. another nurse added/removed a patient
  // while this one was mid-drag.
  | { ok: false; reason: "STALE_SET" };

/**
 * Pure planning logic for ReorderQueueHandler's "Confirmar Nova Sequência" commit, kept out
 * of the handler so the actual reordering arithmetic doesn't require a database to exercise
 * (apps/api has no unit-test runner -- this is still only reached via e2e today, but keeping
 * it pure means it *could* be unit-tested the moment one exists, without a rewrite).
 *
 * Only WAITING entries participate: an entry already IN_PROGRESS is on the table, and
 * DONE/CANCELLED is finished history -- neither has a "priority" left to reorder. Their
 * positions are left completely untouched; the WAITING entries are renumbered into exactly
 * the position slots they already collectively occupy (ascending), so this never needs to
 * touch, or even know about, any entry outside the WAITING set.
 */
export function planQueueReorder(entries: readonly QueueEntry[], orderedIds: readonly string[]): QueueReorderPlan {
  const waiting = entries.filter((entry) => entry.status === QueueStatus.WAITING);
  const waitingIds = new Set(waiting.map((entry) => entry.id));
  const orderedIdSet = new Set(orderedIds);

  const nonWaitingEntry = entries.find((entry) => entry.status !== QueueStatus.WAITING && orderedIdSet.has(entry.id));
  if (nonWaitingEntry) {
    return { ok: false, reason: "INCLUDES_NON_WAITING" };
  }

  if (orderedIdSet.size !== waitingIds.size || ![...waitingIds].every((id) => orderedIdSet.has(id))) {
    return { ok: false, reason: "STALE_SET" };
  }

  const waitingByPosition = [...waiting].sort((a, b) => a.position - b.position);
  const currentOrder = waitingByPosition.map((entry) => entry.id);
  if (currentOrder.every((id, index) => id === orderedIds[index])) {
    return { ok: true, noop: true };
  }

  const slots = waitingByPosition.map((entry) => entry.position);
  const assignments = orderedIds.map((id, index) => ({ id, position: slots[index] }));

  return { ok: true, noop: false, assignments };
}
