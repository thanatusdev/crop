/**
 * Brazilian federative unit (UF) codes -- the two-letter state abbreviation every Brazilian
 * postal/regulatory address uses. Kept as a static list, the same pattern
 * `hid/keymaps.ts`'s `PIKVM_KEYMAPS` already uses for PiKVM's closed set of keyboard
 * layouts: stored as a plain `String` column (`Unit.state`), validated against this closed
 * set at the contract boundary, rather than a 27-member Prisma enum. That keeps a future
 * addition (there won't be one -- Brazil's 26 states + the Federal District are a fixed,
 * constitutional set) or a display-label change out of the database layer entirely.
 */
export const BR_STATES = [
  "AC",
  "AL",
  "AP",
  "AM",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MT",
  "MS",
  "MG",
  "PA",
  "PB",
  "PR",
  "PE",
  "PI",
  "RJ",
  "RN",
  "RS",
  "RO",
  "RR",
  "SC",
  "SP",
  "SE",
  "TO",
] as const;

export type BrazilianState = (typeof BR_STATES)[number];

export function isValidBrazilianState(value: string): value is BrazilianState {
  return (BR_STATES as readonly string[]).includes(value);
}
