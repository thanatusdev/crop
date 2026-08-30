import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AccessTokenClaims } from "@crop/shared";

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AccessTokenClaims => {
  return ctx.switchToHttp().getRequest<{ user: AccessTokenClaims }>().user;
});
