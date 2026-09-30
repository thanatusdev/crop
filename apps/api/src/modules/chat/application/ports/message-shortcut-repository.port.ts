import type { MessageShortcut } from "../../domain/message-shortcut.entity.js";

export const MESSAGE_SHORTCUT_REPOSITORY = Symbol("MESSAGE_SHORTCUT_REPOSITORY");

export interface CreateMessageShortcutData {
  tenantId: string;
  code: string;
  label: string;
  body: string;
  createdByUserId: string | null;
}

export interface MessageShortcutRepositoryPort {
  create(data: CreateMessageShortcutData): Promise<MessageShortcut>;
  findByTenantAndCode(tenantId: string, code: string): Promise<MessageShortcut | null>;
  /** Active shortcuts only. `deactivatedAt` exists on the model for the same reason it does on
   * `Equipment`/`Unit`/`Tenant` (a real, likely lifecycle this codebase always models as
   * soft-deactivation, never a hard delete) -- but no command in this pass ever sets it; the
   * business rule this feature was built from names only "Create new shortcut". Filtering on
   * it here is what keeps that column meaningful the day a deactivate action is added, rather
   * than this query needing to change at the same time that command does. */
  listActiveByTenant(tenantId: string): Promise<MessageShortcut[]>;
  /** Inserts `DEFAULT_MESSAGE_SHORTCUTS` for one tenant, skipping any `(tenantId, code)` that
   * already exists -- the live-code counterpart to the `exam_chat_and_shortcuts` migration's
   * own one-time `ON CONFLICT DO NOTHING` backfill, used by `SeedDefaultShortcutsHandler` for
   * every tenant created *after* that migration ran. Idempotent by the same unique index, so
   * calling this twice for the same tenant (e.g. a retried event) is harmless. */
  seedDefaults(tenantId: string): Promise<void>;
}
