import type { AccessTokenClaims } from "@crop/shared";

/** `JOIN_EQUIPMENT_CHAT`'s access check, dispatched from `SessionsGateway` -- see that
 * event's own docstring for why the gateway needs a query into `ChatModule` rather than
 * `SessionsModule` importing `AccessModule` directly (the identical anti-cycle shape
 * `onJoinSession`'s own `GetEquipmentQuery` dispatch already uses). Answers only "may this
 * actor join", nothing more -- unlike `ListExamMessagesQuery`, there is no list to return. */
export class CanAccessEquipmentChatQuery {
  constructor(
    public readonly equipmentId: string,
    public readonly actor: AccessTokenClaims
  ) {}
}
