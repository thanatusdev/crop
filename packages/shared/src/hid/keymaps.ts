/**
 * PiKVM keyboard layouts, as returned by `GET /api/hid/keymaps`.
 * Kept as a static list (rather than fetched at runtime) so the UI can render
 * a picker before ever talking to a device, and so equipment can be configured offline.
 * Source: PiKVM Handbook, HTTP API reference, "Get keyboard layouts".
 */
export const PIKVM_KEYMAPS = [
  "ar",
  "bepo",
  "cz",
  "da",
  "de",
  "de-ch",
  "en-gb",
  "en-us",
  "en-us-altgr-intl",
  "en-us-colemak",
  "es",
  "et",
  "fi",
  "fo",
  "fr",
  "fr-be",
  "fr-ca",
  "fr-ch",
  "hr",
  "hu",
  "is",
  "it",
  "ja",
  "lt",
  "lv",
  "mk",
  "nl",
  "no",
  "pl",
  "pt",
  "pt-br",
  "ru",
  "sl",
  "sv",
  "th",
  "tr",
] as const;

export type PiKvmKeymap = (typeof PIKVM_KEYMAPS)[number];

export const DEFAULT_KEYMAP: PiKvmKeymap = "en-us";

export function isValidKeymap(value: string): value is PiKvmKeymap {
  return (PIKVM_KEYMAPS as readonly string[]).includes(value);
}
