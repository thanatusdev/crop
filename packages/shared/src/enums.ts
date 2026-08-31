/** Tenant classification. */
export enum TenantType {
  CLINIC = "CLINIC",
  OPERATOR_PROVIDER = "OPERATOR_PROVIDER",
  PLATFORM = "PLATFORM",
}

/** Application-level roles. Distinct from PiKVM, which has no role concept at all. */
export enum UserRole {
  PLATFORM_ADMIN = "PLATFORM_ADMIN",
  CLINIC_ADMIN = "CLINIC_ADMIN",
  SUPERVISOR = "SUPERVISOR",
  OPERATOR = "OPERATOR",
  AUDITOR = "AUDITOR",
}

export enum EquipmentStatus {
  ONLINE = "ONLINE",
  OFFLINE = "OFFLINE",
  DEGRADED = "DEGRADED",
  MAINTENANCE = "MAINTENANCE",
}

/** Operating system running on the *controlled* (clinical) machine, not the operator's browser. */
export enum TargetOs {
  WINDOWS = "WINDOWS",
  MACOS = "MACOS",
  LINUX = "LINUX",
}

export enum MouseMode {
  ABSOLUTE = "ABSOLUTE",
  RELATIVE = "RELATIVE",
}

export enum SessionStatus {
  PENDING = "PENDING",
  ACTIVE = "ACTIVE",
  ENDED = "ENDED",
  ABORTED = "ABORTED",
}

export enum QueueStatus {
  WAITING = "WAITING",
  IN_PROGRESS = "IN_PROGRESS",
  DONE = "DONE",
  CANCELLED = "CANCELLED",
}

/**
 * Every action that can produce an AuditLog row. Kept as a flat string enum (not free text)
 * so audit queries and compliance reports can rely on a closed set of values.
 *
 * Deliberately does NOT include an `MFA_SUCCESS` or `BLOCKED_ATX_ATTEMPT`/`BLOCKED_MSD_ATTEMPT`
 * -- all three existed here for a while but were never actually wired to anything, and none
 * of them turned out to have a real reason to exist. `LOGIN_SUCCESS` already *is* "MFA step
 * passed" (see VerifyMfaHandler's own comment: MFA is mandatory, so there is no meaningful
 * "logged in" moment that isn't also "passed MFA" -- a separate event would just duplicate
 * it). ATX/MSD control is never implemented at all, on purpose (see docs/architecture.md and
 * docs/pikvm-integration.md), so there is no code path that could ever emit a "blocked
 * attempt" at either -- keeping enum values for an attempt that can structurally never
 * happen is speculative dead weight, not forward-looking design.
 */
export enum AuditAction {
  LOGIN_SUCCESS = "LOGIN_SUCCESS",
  LOGIN_FAILURE = "LOGIN_FAILURE",
  LOGOUT = "LOGOUT",
  MFA_CHALLENGE_SENT = "MFA_CHALLENGE_SENT",
  MFA_FAILURE = "MFA_FAILURE",
  SESSION_START = "SESSION_START",
  SESSION_END = "SESSION_END",
  SESSION_ABORT = "SESSION_ABORT",
  TAKEOVER_REQUESTED = "TAKEOVER_REQUESTED",
  TAKEOVER_GRANTED = "TAKEOVER_GRANTED",
  RETURN_CONTROL_REQUESTED = "RETURN_CONTROL_REQUESTED",
  RETURN_CONTROL_GRANTED = "RETURN_CONTROL_GRANTED",
  INPUT_BATCH = "INPUT_BATCH",
  PRINT_TEXT = "PRINT_TEXT",
  HID_RESET = "HID_RESET",
  SNAPSHOT_CAPTURED = "SNAPSHOT_CAPTURED",
  EQUIPMENT_CREATED = "EQUIPMENT_CREATED",
  EQUIPMENT_UPDATED = "EQUIPMENT_UPDATED",
  QUEUE_ENTRY_CREATED = "QUEUE_ENTRY_CREATED",
  QUEUE_ENTRY_UPDATED = "QUEUE_ENTRY_UPDATED",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  ACCOUNT_LOCKED = "ACCOUNT_LOCKED",
  ACCOUNT_UNLOCKED = "ACCOUNT_UNLOCKED",
  PASSWORD_RESET_BY_ADMIN = "PASSWORD_RESET_BY_ADMIN",
}
