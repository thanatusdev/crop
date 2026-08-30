import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/**
 * The explicit no-arg constructor is deliberate, not boilerplate: without it, TypeScript
 * emits no `design:paramtypes` of its own for this subclass, so Nest resolves the mixin
 * base class's `AuthModuleOptions` dependency fresh in *whichever module first uses this
 * guard* via `@UseGuards(JwtAuthGuard)` -- which fails everywhere except IamModule itself,
 * since only IamModule imports `PassportModule.register(...)`. This constructor makes
 * JwtAuthGuard's own dependency list empty, so every module can use it with zero DI wiring.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor() {
    super();
  }
}
