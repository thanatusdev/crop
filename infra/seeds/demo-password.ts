/**
 * Single source of truth for the one password every seed.ts account shares (demo
 * convenience only -- see seed.ts's own comment). Also imported by
 * infra/scripts/totp-codes.ts so the two scripts can never drift apart.
 */
export const DEMO_PASSWORD = "SenhaForte123!";
