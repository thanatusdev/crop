/** `GET /auth/me` -- the caller's own identity. See `MeResponseSchema`'s own docstring in
 * packages/shared/src/contracts/auth.ts for why this is self-scoped by construction (reads
 * `AccessTokenClaims.sub` and nothing else) rather than a widening of `GET /users/:id`. */
export class GetMeQuery {
  constructor(public readonly userId: string) {}
}
