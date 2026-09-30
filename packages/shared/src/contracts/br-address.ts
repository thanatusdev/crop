import { z } from "zod";

/**
 * A Brazilian CEP (postal code), accepted with or without the conventional hyphen and
 * normalized to `NNNNN-NNN` for storage/display. This validates *format* only -- there is
 * no lookup against Correios or any other postal database (a prototype screen this was
 * built from claimed "CEP validado via base de correios"; this codebase makes no such
 * claim, and the UI label says so plainly). Shared between `contracts/units.ts` and
 * `contracts/tenants.ts`, both of which collect a full Brazilian address.
 */
export const ZipCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{5}-?\d{3}$/, "CEP must be 8 digits, optionally formatted as NNNNN-NNN")
  .transform((value) => {
    const digits = value.replace(/\D/g, "");
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  });

/**
 * A loose phone-number format check -- digits, spaces, parentheses, `+`, and `-`, 8-20
 * characters. Deliberately not Brazil-specific (no fixed DDD+8/9-digit assumption): this
 * field is optional contact metadata, nothing in the platform dials it, and an operator
 * company (or a clinic with an international contact number) shouldn't be locked out by a
 * validation rule invented for this feature alone.
 */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^[+()\d\s-]{8,20}$/, "Phone must be 8-20 characters using only digits, spaces, (), + or -");
