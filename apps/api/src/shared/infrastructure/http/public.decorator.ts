import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/**
 * Opts a route (or a whole controller) out of the global JwtAuthGuard. Every HTTP route
 * requires a valid access token unless it says otherwise here -- so a new controller that
 * forgets its guards fails closed, not open. Lives in shared/ rather than iam/ because
 * non-IAM controllers (MetricsController) need it too.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
