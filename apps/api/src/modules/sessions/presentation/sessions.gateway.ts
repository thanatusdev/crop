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
  PrintTextRequestSchema,
  RT_EVENTS,
  type AccessTokenClaims,
  type ControllerChangedEvent,
  type EquipmentStatus,
  type HidInputEvent,
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
    private readonly queryBus: QueryBus
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
    // Safety net for a crashed/closed tab: if the disconnecting socket was the current
    // controller, release any physically-held key/button rather than waiting for an
    // explicit "End Session" that may never come. See docs/architecture.md.
    if (data.session && this.runtime.getController(data.session.sessionId) === data.user.sub) {
      await this.pikvm.releaseAllInput(data.session.equipmentId).catch((err: Error) => {
        this.logger.error(`releaseAllInput on disconnect failed: ${err.message}`);
      });
    }
  }

  @SubscribeMessage(RT_EVENTS.JOIN_SESSION)
  async onJoinSession(@ConnectedSocket() client: Socket, @MessageBody() body: { sessionId: string }): Promise<void> {
    const data = client.data as SocketData;
    const session = await this.queryBus.execute(new GetSessionQuery(body.sessionId, data.user.tenantId));
    if (!session.isParticipant(data.user.sub)) {
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

    const payload: ControllerChangedEvent = {
      sessionId: session.id,
      controllerUserId: session.controllerUserId,
      controllerName: data.user.sub, // email is only known to IAM; sub (userId) is enough to key UI state client-side
      reason: "takeover",
    };
    this.server.to(room(session.id)).emit(RT_EVENTS.CONTROLLER_CHANGED, payload);
    this.server.to(room(session.id)).emit(RT_EVENTS.SESSION_STATE, toSessionDto(session));
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

    const payload: ControllerChangedEvent = {
      sessionId: session.id,
      controllerUserId: session.controllerUserId,
      controllerName: session.controllerUserId,
      reason: "return_to_operator",
    };
    this.server.to(room(session.id)).emit(RT_EVENTS.CONTROLLER_CHANGED, payload);
    this.server.to(room(session.id)).emit(RT_EVENTS.SESSION_STATE, toSessionDto(session));
  }

  @SubscribeMessage(RT_EVENTS.LATENCY_PING)
  onLatencyPing(@ConnectedSocket() client: Socket, @MessageBody() body: { clientTs: number }): void {
    client.emit(RT_EVENTS.LATENCY_PONG, { clientTs: body.clientTs, serverTs: Date.now() });
  }

  /** Called by SessionsController after a REST-initiated end, so every connected participant's UI updates live. */
  broadcastSessionEnded(sessionId: string): void {
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

  /**
   * Populates `data.session` (required by onHidInput/onPrintText) and joins the socket to
   * the session's room (required to receive CONTROLLER_CHANGED/SESSION_STATE/SESSION_ENDED
   * broadcasts). Shared by onJoinSession and by onTakeoverRequest/onReturnControlRequest --
   * see the latter two's comments for why a caller who just won or lost control needs this
   * exact side effect applied to *their own* socket, not just a room-wide broadcast.
   */
  private async joinRoom(
    client: Socket,
    data: SocketData,
    sessionId: string,
    equipmentId: string,
    tenantId: string
  ): Promise<void> {
    const equipment = await this.queryBus.execute(new GetEquipmentQuery(equipmentId, tenantId));
    data.session = { sessionId, equipmentId, targetOs: equipment.targetOs, keymap: equipment.keymap };
    await client.join(room(sessionId));
  }
}
