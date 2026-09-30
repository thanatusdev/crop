import { Inject, Logger } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import {
  HidInputEventSchema,
  JoinEquipmentChatRequestSchema,
  PrintTextRequestSchema,
  RT_EVENTS,
  UserRole,
  type AccessTokenClaims,
  type ControllerChangedEvent,
  type EquipmentStatus,
  type ExamMessageDto,
  type HidInputEvent,
  type PatientPreparationUpdatedEvent,
  type TargetOs,
} from "@crop/shared";
import { TOKEN_SERVICE, type TokenServicePort } from "../../iam/application/ports/token-service.port.js";
import { GetEquipmentQuery } from "../../equipment/application/queries/get-equipment/get-equipment.query.js";
import { ExecuteTakeoverCommand } from "../application/commands/execute-takeover/execute-takeover.command.js";
import { ReturnControlToOperatorCommand } from "../application/commands/return-control-to-operator/return-control-to-operator.command.js";
import { PrintTextCommand } from "../application/commands/print-text/print-text.command.js";
import { ProcessHidInputCommand } from "../application/commands/process-hid-input/process-hid-input.command.js";
import { GetSessionQuery } from "../application/queries/get-session/get-session.query.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../application/ports/pikvm-gateway.port.js";
import { SESSION_RUNTIME, type SessionRuntimePort } from "../application/ports/session-runtime.port.js";
import { SessionParticipantNameService } from "../application/session-participant-name.service.js";
import { CanAccessEquipmentChatQuery } from "../../chat/application/queries/can-access-equipment-chat/can-access-equipment-chat.query.js";
import { toSessionDto } from "./session.dto.js";

interface JoinedSessionContext {
  sessionId: string;
  equipmentId: string;
  targetOs: TargetOs;
  keymap: string;
}

interface SocketData {
  user: AccessTokenClaims;
  session?: JoinedSessionContext;
}

function room(sessionId: string): string {
  return `session:${sessionId}`;
}

function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/** The exam-support chat's own room, joined via `JOIN_EQUIPMENT_CHAT` -- deliberately not
 * `room(equipmentId)` (a different id namespace than `session:<id>`, but string-templated
 * ids from two different entity types have collided by coincidence before in less careful
 * codebases, so this stays its own named prefix rather than relying on session ids and
 * equipment ids never accidentally matching). See `RT_EVENTS.JOIN_EQUIPMENT_CHAT`'s own
 * docstring for why this room exists independently of `room(sessionId)` at all. */
function equipmentChatRoom(equipmentId: string): string {
  return `equipment:${equipmentId}`;
}

// Deliberately the same set ExecuteTakeoverHandler/ReturnControlToOperatorHandler use:
// whoever is eligible to take control away from the operator must also be able to *watch*
// the session live before doing so (e.g. via DashboardPage's "Rejoin session", which shows
// for any active session regardless of who's currently viewing it) -- otherwise their socket
// never joins `room(sessionId)` at all, and they silently never receive SESSION_ENDED/
// CONTROLLER_CHANGED/SESSION_STATE for a session they can see perfectly well over REST. This
// used to be gated to `session.isParticipant()` alone, which is only ever true for the
// operator or a supervisor who has *already* taken over -- a supervisor who merely opened
// the session to look, without taking over, got silently rejected here, and was left stuck
// on SessionPage forever once the operator ended the session from their side: their own
// "End session" button also failed (EndSessionHandler correctly requires `isParticipant`),
// and with no SESSION_ENDED ever reaching them, nothing ever redirected them away either.
// Real bug, found by hand, not by an e2e test -- see docs/architecture.md.
// OPERATOR_ADMIN added alongside the clinic/operator-provider role split (see
// packages/shared/src/roles.ts) -- an operator company's admin needs the same live-view
// eligibility as OPERATIONAL_SUPERVISOR (renamed from SUPERVISOR) and CLINIC_ADMIN already
// have.
const VIEW_ALLOWED_ROLES: readonly UserRole[] = [
  UserRole.OPERATIONAL_SUPERVISOR,
  UserRole.CLINIC_ADMIN,
  UserRole.PLATFORM_ADMIN,
  UserRole.OPERATOR_ADMIN,
];

/**
 * The real-time control plane: session join, HID input, print-text, takeover, and latency
 * ping all flow through this single namespace. Video does NOT -- see MediaStreamServer,
 * a plain `ws` server on a separate path, since Socket.io's framing overhead on a 60fps
 * H.264 stream would cost part of the latency budget for no benefit.
 */
@WebSocketGateway({
  path: "/rt",
  // Can't inject ConfigService here -- `@WebSocketGateway`'s options are evaluated at class
  // *definition* time (module import), before Nest's DI container exists, so this has to
  // fall back to raw `process.env` like main.ts's `.env`-file-loading concern already does
  // for a couple of other vars (see docs/architecture.md). The fallback value itself, not
  // just the lookup, must stay in sync with `EnvSchema`'s own `CORS_ORIGIN` default in
  // env.validation.ts -- it silently drifted to `"*"` here at some point while main.ts used
  // the real default (`http://localhost:5173`), which would have made this specific gateway
  // permissive to every origin while the rest of the API stayed properly scoped.
  cors: { origin: process.env.CORS_ORIGIN ?? "http://localhost:5173" },
  // Compression adds CPU overhead per message for negligible savings on tiny, frequent JSON
  // payloads (a HID event is a few dozen bytes) -- not worth it on a channel where latency,
  // not bandwidth, is the constraint. Unrelated to (and not a fix for) the WS-framing bug
  // documented on MediaStreamServer; that one was a genuine multiplexing bug, not a
  // compression-negotiation mismatch, despite how the original symptom looked.
  perMessageDeflate: false,
})
export class SessionsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() private readonly server!: Server;
  private readonly logger = new Logger(SessionsGateway.name);

  constructor(
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    @Inject(SESSION_RUNTIME) private readonly runtime: SessionRuntimePort,
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly participantNames: SessionParticipantNameService
  ) {}

  handleConnection(client: Socket): void {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const user = this.tokens.verifyAccessToken(token);
      (client.data as SocketData).user = user;
      // Every connected client auto-joins its own tenant's room -- this is what lets
      // broadcastQueueUpdated/broadcastEquipmentStatusChanged reach every dashboard for that
      // tenant without a separate explicit "subscribe to my tenant" message, and without
      // ever reaching a different tenant's clients (queue contents and equipment status are
      // exactly the kind of thing that must never leak across tenants).
      void client.join(tenantRoom(user.tenantId));
    } catch {
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const data = client.data as SocketData;
    if (!data.session) return;

    // If the disconnecting socket was the current controller, release any physically-held
    // key/button rather than waiting for an explicit "End Session" that may never come. See
    // docs/architecture.md. (Used to run alongside a second, push-to-talk cleanup branch in
    // a `Promise.all` -- removed with the intercom feature itself; see that feature's own
    // removal note on `INTERCOM_PRESENCE`.)
    if (this.runtime.getController(data.session.sessionId) === data.user.sub) {
      await this.pikvm.releaseAllInput(data.session.equipmentId).catch((err: Error) => {
        this.logger.error(`releaseAllInput on disconnect failed: ${err.message}`);
      });
    }
  }

  @SubscribeMessage(RT_EVENTS.JOIN_SESSION)
  async onJoinSession(@ConnectedSocket() client: Socket, @MessageBody() body: { sessionId: string }): Promise<void> {
    const data = client.data as SocketData;
    const session = await this.queryBus.execute(new GetSessionQuery(body.sessionId, data.user.tenantId));
    // Participants (operator, or a supervisor who already took over) always may; anyone
    // else needs a takeover-eligible role -- see VIEW_ALLOWED_ROLES's own comment. This is a
    // *view* gate only: actually sending input still requires holding control, checked
    // separately (and unconditionally) by onHidInput/onPrintText below, so widening this
    // does not let a mere viewer act on the equipment.
    if (!session.isParticipant(data.user.sub) && !VIEW_ALLOWED_ROLES.includes(data.user.role)) {
      client.emit(RT_EVENTS.ERROR, { message: "Not a participant of this session" });
      return;
    }

    await this.joinRoom(client, data, session.id, session.equipmentId, data.user.tenantId);
  }

  @SubscribeMessage(RT_EVENTS.HID_INPUT)
  async onHidInput(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): Promise<void> {
    const data = client.data as SocketData;
    if (!data.session) return;

    const parsed = HidInputEventSchema.safeParse(body);
    if (!parsed.success) return;

    // Gate BEFORE dispatching a command: at up to 60 events/sec, this avoids both the
    // CommandBus overhead and an error emission for every event once someone loses control.
    if (this.runtime.getController(data.session.sessionId) !== data.user.sub) return;

    const event: HidInputEvent = parsed.data;
    await this.commandBus.execute(
      new ProcessHidInputCommand(
        data.session.sessionId,
        data.user.tenantId,
        data.session.equipmentId,
        data.user.sub,
        data.user.clientOs,
        data.session.targetOs,
        event
      )
    );
  }

  @SubscribeMessage(RT_EVENTS.PRINT_TEXT)
  async onPrintText(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): Promise<void> {
    const data = client.data as SocketData;
    if (!data.session) return;

    // `PrintTextRequestSchema` existed in @crop/shared from early on but was never actually
    // used to validate anything -- this handler took whatever shape TypeScript's structural
    // typing happened to let through, with no runtime check at all (unlike HID_INPUT, which
    // already `.safeParse`s against `HidInputEventSchema`). A max length matters here
    // specifically: PrintTextHandler forwards this straight to PiKVM's `/api/hid/print`
    // per-character, so an unbounded string is an unbounded number of HID events sent to
    // real clinical equipment for one WS message.
    const parsed = PrintTextRequestSchema.safeParse(body);
    if (!parsed.success) return;

    await this.commandBus.execute(
      new PrintTextCommand(
        data.session.sessionId,
        data.user.tenantId,
        data.session.equipmentId,
        data.user.sub,
        data.session.keymap,
        parsed.data.text
      )
    );
  }

  /**
   * Joins the socket to one equipment's own exam-support chat room -- see
   * `RT_EVENTS.JOIN_EQUIPMENT_CHAT`'s own docstring for why this room is separate from
   * `room(sessionId)`. Sending itself is `POST /chat/messages` now (see
   * `SendExamMessageRequestSchema`'s own docstring); this handler exists purely so a joined
   * socket receives the live `EXAM_MESSAGE_CREATED` broadcast that write produces. Dispatches
   * a query into `ChatModule` (`CanAccessEquipmentChatQuery`) rather than checking access
   * inline, the same anti-cycle shape `onJoinSession`'s own `GetEquipmentQuery` dispatch
   * already uses for `EquipmentModule` -- see that query's own docstring.
   */
  /**
   * Joins the socket to one equipment's own exam-support chat room -- see
   * `RT_EVENTS.JOIN_EQUIPMENT_CHAT`'s own docstring for why this room is separate from
   * `room(sessionId)`. Sending itself is `POST /chat/messages` now (see
   * `SendExamMessageRequestSchema`'s own docstring); this handler exists purely so a joined
   * socket receives the live `EXAM_MESSAGE_CREATED` broadcast that write produces. Dispatches
   * a query into `ChatModule` (`CanAccessEquipmentChatQuery`) rather than checking access
   * inline, the same anti-cycle shape `onJoinSession`'s own `GetEquipmentQuery` dispatch
   * already uses for `EquipmentModule` -- see that query's own docstring.
   */
  @SubscribeMessage(RT_EVENTS.JOIN_EQUIPMENT_CHAT)
  async onJoinEquipmentChat(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): Promise<void> {
    const data = client.data as SocketData;
    const parsed = JoinEquipmentChatRequestSchema.safeParse(body);
    if (!parsed.success) return;

    try {
      await this.queryBus.execute(new CanAccessEquipmentChatQuery(parsed.data.equipmentId, data.user));
    } catch (err) {
      client.emit(RT_EVENTS.ERROR, { message: err instanceof Error ? err.message : "Not authorized to join this room's chat" });
      return;
    }
    await client.join(equipmentChatRoom(parsed.data.equipmentId));
  }

  @SubscribeMessage(RT_EVENTS.TAKEOVER_REQUEST)
  async onTakeoverRequest(@ConnectedSocket() client: Socket, @MessageBody() body: { sessionId: string }): Promise<void> {
    const data = client.data as SocketData;
    const session = await this.commandBus.execute(
      new ExecuteTakeoverCommand(body.sessionId, data.user.tenantId, data.user.sub, data.user.role)
    );

    // The incoming controller almost certainly wasn't a participant (and so never joined
    // the room, and never got `data.session` populated) *before* this call -- takeover is
    // precisely how a supervisor/admin *becomes* one. Without this, their own socket would
    // never receive the broadcast below confirming their own takeover, and worse, every
    // subsequent HID_INPUT/PRINT_TEXT from them would silently no-op forever (`onHidInput`
    // requires `data.session`, which only `JOIN_SESSION` -- never attempted successfully by
    // them until now -- would otherwise have set). Found by actually driving this feature
    // through two real browser sessions instead of only backend-level e2e tests.
    await this.joinRoom(client, data, session.id, session.equipmentId, data.user.tenantId);

    // Used to be `data.user.sub` -- a raw userId, not a name (see ControllerChangedEvent's
    // own docstring). The acting caller here always is the incoming controller (unlike
    // return-control below), so their own claims already have everything needed except the
    // display name itself.
    const controllerName = await this.participantNames.resolveUserName(data.user.sub);
    const payload: ControllerChangedEvent = {
      sessionId: session.id,
      controllerUserId: session.controllerUserId,
      controllerName,
      reason: "takeover",
    };
    this.server.to(room(session.id)).emit(RT_EVENTS.CONTROLLER_CHANGED, payload);
    this.server.to(room(session.id)).emit(RT_EVENTS.SESSION_STATE, toSessionDto(session, await this.participantNames.resolveOperatorProfile(session)));
  }

  @SubscribeMessage(RT_EVENTS.RETURN_CONTROL_REQUEST)
  async onReturnControlRequest(@ConnectedSocket() client: Socket, @MessageBody() body: { sessionId: string }): Promise<void> {
    const data = client.data as SocketData;
    const session = await this.commandBus.execute(
      new ReturnControlToOperatorCommand(body.sessionId, data.user.tenantId, data.user.sub, data.user.role)
    );

    // The acting supervisor/admin isn't necessarily the new controller here (control always
    // goes to the operator, see ReturnControlToOperatorHandler) -- but they were a
    // participant already (a prior takeover made them one), so this is a no-op re-join for
    // them, not a fix. It's a genuine fix for the *operator's own* socket in the common case
    // where they're still connected from before losing control: their `data.session` was
    // already populated from their original join, so this line changes nothing for them
    // either. Kept for symmetry with onTakeoverRequest and because it's harmless either way.
    await this.joinRoom(client, data, session.id, session.equipmentId, data.user.tenantId);

    // Control always goes to the operator on return (see ReturnControlToOperatorHandler),
    // so `session.controllerUserId` is now the operator's id, not the acting caller's --
    // resolve *that* id's name, not `data.user.sub`. Used to be `session.controllerUserId`
    // itself (a raw userId, not a name -- see ControllerChangedEvent's own docstring).
    const controllerName = await this.participantNames.resolveUserName(session.controllerUserId);
    const payload: ControllerChangedEvent = {
      sessionId: session.id,
      controllerUserId: session.controllerUserId,
      controllerName,
      reason: "return_to_operator",
    };
    this.server.to(room(session.id)).emit(RT_EVENTS.CONTROLLER_CHANGED, payload);
    this.server.to(room(session.id)).emit(RT_EVENTS.SESSION_STATE, toSessionDto(session, await this.participantNames.resolveOperatorProfile(session)));
  }

  @SubscribeMessage(RT_EVENTS.LATENCY_PING)
  onLatencyPing(@ConnectedSocket() client: Socket, @MessageBody() body: { clientTs: number }): void {
    client.emit(RT_EVENTS.LATENCY_PONG, { clientTs: body.clientTs, serverTs: Date.now() });
  }

  /** Called by SessionsController after a REST-initiated end, so every connected participant's
   * UI updates live. */
  async broadcastSessionEnded(sessionId: string): Promise<void> {
    this.server.to(room(sessionId)).emit(RT_EVENTS.SESSION_ENDED, { sessionId });
  }

  /** Called by BroadcastQueueUpdatedHandler (an @EventsHandler reacting to QueueUpdatedEvent,
   * published by the queue module) -- see that event's own docstring for why this indirection
   * exists instead of QueueModule calling this directly. */
  broadcastQueueUpdated(tenantId: string, equipmentId: string): void {
    this.server.to(tenantRoom(tenantId)).emit(RT_EVENTS.QUEUE_UPDATED, { equipmentId });
  }

  /** Same shape as broadcastQueueUpdated, reacting to EquipmentStatusChangedEvent. */
  broadcastEquipmentStatusChanged(tenantId: string, equipmentId: string, status: EquipmentStatus): void {
    this.server.to(tenantRoom(tenantId)).emit(RT_EVENTS.EQUIPMENT_STATUS_CHANGED, { equipmentId, status });
  }

  /** Called by BroadcastPatientPreparationUpdatedHandler, reacting to
   * PatientPreparationUpdatedEvent (published by the queue module's
   * UpdatePreparationStatusHandler) -- same anti-cycle indirection as
   * broadcastQueueUpdated. Emitted to the equipment's tenant room always (drives
   * NursingPage's queue table and DashboardPage), and additionally to the session room when
   * one exists yet (drives SessionPage's live "Preparo do Paciente" panel with zero
   * refetch) -- mirrors CONTROLLER_CHANGED/SESSION_STATE's own room fan-out above. */
  broadcastPatientPreparationUpdated(tenantId: string, sessionId: string | null, payload: PatientPreparationUpdatedEvent): void {
    this.server.to(tenantRoom(tenantId)).emit(RT_EVENTS.PATIENT_PREPARATION_UPDATED, payload);
    if (sessionId) {
      this.server.to(room(sessionId)).emit(RT_EVENTS.PATIENT_PREPARATION_UPDATED, payload);
    }
  }

  /** Called by `BroadcastExamMessageHandler`, reacting to `ExamMessageSentEvent` (published
   * by `ChatModule`'s own `SendExamMessageHandler` after `POST /chat/messages` persists a
   * message) -- same anti-cycle indirection as `broadcastQueueUpdated`, just travelling from
   * `ChatModule` into this one instead of from `QueueModule`. Broadcast to the equipment's
   * own chat room (`equipmentChatRoom`), not `room(sessionId)` -- see
   * `RT_EVENTS.JOIN_EQUIPMENT_CHAT`'s own docstring for why this chat outlives, and is
   * reachable outside of, any one session. */
  broadcastExamMessage(equipmentId: string, message: ExamMessageDto): void {
    this.server.to(equipmentChatRoom(equipmentId)).emit(RT_EVENTS.EXAM_MESSAGE_CREATED, message);
  }

  /**
   * Populates `data.session` (required by onHidInput/onPrintText) and joins the socket to
   * the session's room (required to receive CONTROLLER_CHANGED/SESSION_STATE/SESSION_ENDED
   * broadcasts). Shared by onJoinSession and by onTakeoverRequest/onReturnControlRequest --
   * see the latter two's comments for why a caller who just won or lost control needs this
   * exact side effect applied to *their own* socket, not just a room-wide broadcast.
   */
  private async joinRoom(client: Socket, data: SocketData, sessionId: string, equipmentId: string, tenantId: string): Promise<void> {
    const equipment = await this.queryBus.execute(new GetEquipmentQuery(equipmentId, tenantId));
    data.session = { sessionId, equipmentId, targetOs: equipment.targetOs, keymap: equipment.keymap };
    await client.join(room(sessionId));
  }
}
