import { Inject, Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import type { AccessTokenClaims } from "@crop/shared";

@Injectable()
export class JwtAccessStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(@Inject(ConfigService) config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>("JWT_ACCESS_SECRET"),
      ignoreExpiration: false,
    });
  }

  /** Whatever this returns becomes `request.user`, consumed by @CurrentUser(). */
  validate(payload: AccessTokenClaims): AccessTokenClaims {
    return payload;
  }
}
