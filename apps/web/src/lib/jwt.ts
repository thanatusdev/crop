/**
 * Decodes a JWT payload without verifying the signature. This is only ever used to read
 * claims for UI rendering (e.g. showing the user's role) -- the backend independently and
 * authoritatively re-verifies every token on every request, so a tampered token here would
 * only ever produce a cosmetic UI glitch, never a security decision.
 */
export function decodeJwtPayload<T>(token: string): T {
  const [, payload] = token.split(".");
  if (!payload) throw new Error("Malformed JWT");
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json) as T;
}
