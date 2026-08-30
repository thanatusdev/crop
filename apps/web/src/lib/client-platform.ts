import { TargetOs } from "@crop/shared";

/**
 * Detects the operator's own platform (not the equipment being controlled) so the backend
 * can decide whether to swap Control<->Meta -- see @crop/shared's remapModifierCode and
 * docs/architecture.md's macOS-operator / Windows-target scenario, which is exactly this
 * demo's setup.
 */
export function detectClientOs(): TargetOs {
  const platform = navigator.userAgent;
  if (/Mac/i.test(platform)) return TargetOs.MACOS;
  if (/Linux/i.test(platform) && !/Android/i.test(platform)) return TargetOs.LINUX;
  return TargetOs.WINDOWS;
}
