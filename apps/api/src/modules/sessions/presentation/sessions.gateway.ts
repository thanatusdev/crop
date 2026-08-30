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
  RT_EVENTS,
  type AccessTokenClaims,
  type ControllerChangedEvent,
  type HidInputEvent,
  type TargetOs,
} from "@crop/shared";
import { TOKEN_SERVICE, type TokenServicePort } from "../../iam/application/ports/token-service.port.js";
import { GetEquipmentQuery } from "../../equipment/application/queries/get-equipment/get-equipment.query.js";
import { ExecuteTakeoverCommand } from "../application/commands/execute-takeover/execute-takeover.command.js";
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

/**
 * The real-time control plane: session join, HID input, print-text, takeover, and latency
 * ping all flow through this single namespace. Video does NOT -- see MediaStreamServer,
 * a plain `ws` server on a separate path, since Socket.io's framing overhead on a 60fps
 * H.264 stream would cost part of the latency budget for no benefit.
 */
@WebSocketGateway({
  path: "/rt",
  cors: { origin: process.env.CORS_ORIGIN ?? "*" },
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

    const equipment = await this.queryBus.execute(new GetEquipmentQuery(session.equipmentId, data.user.tenantId));
    data.session = {
      sessionId: session.id,
      equipmentId: session.equipmentId,
      targetOs: equipment.targetOs,
      keymap: equipment.keymap,
    };
    await client.join(room(session.id));
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
  async onPrintText(@ConnectedSocket() client: Socket, @MessageBody() body: { text: string }): Promise<void> {
    const data = client.data as SocketData;
    if (!data.session) return;

    await this.commandBus.execute(
      new PrintTextCommand(
        data.session.sessionId,
        data.user.tenantId,
        data.session.equipmentId,
        data.user.sub,
        data.session.keymap,
        body.text
      )
    );
  }

  @SubscribeMessage(RT_EVENTS.TAKEOVER_REQUEST)
  async onTakeoverRequest(@ConnectedSocket() client: Socket, @MessageBody() body: { sessionId: string }): Promise<void> {
    const data = client.data as SocketData;
    const session = await this.commandBus.execute(
      new ExecuteTakeoverCommand(body.sessionId, data.user.tenantId, data.user.sub, data.user.role)
    );

    const payload: ControllerChangedEvent = {
      sessionId: session.id,
      controllerUserId: session.controllerUserId,
      controllerName: data.user.sub, // email is only known to IAM; sub (userId) is enough to key UI state client-side
      reason: "takeover",
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
}
