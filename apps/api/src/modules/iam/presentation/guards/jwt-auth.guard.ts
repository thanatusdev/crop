import { ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { IS_PUBLIC_KEY } from "../../../../shared/infrastructure/http/public.decorator.js";

/**
 * Registered globally (APP_GUARD, see IamModule): every HTTP route needs a valid access token
 * unless marked `@Public()`. WebSocket handlers are skipped -- SessionsGateway authenticates
 * the socket itself in `handleConnection`, and global guards would otherwise run on every
 * `@SubscribeMessage` too, where there is no HTTP request for passport to read.
 *
 * The explicit constructor is deliberate, not boilerplate: without it, TypeScript emits no
 * `design:paramtypes` of its own for this subclass, so Nest resolves the mixin base class's
 * `AuthModuleOptions` dependency fresh in *whichever module first uses this guard* via
 * `@UseGuards(JwtAuthGuard)` -- which fails everywhere except IamModule itself, since only
 * IamModule imports `PassportModule.register(...)`. Declaring it pins the dependency list to
 * just `Reflector`, which every module can resolve.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    if (context.getType() !== "http") return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
