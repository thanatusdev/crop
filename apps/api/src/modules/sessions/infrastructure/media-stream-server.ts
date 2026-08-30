import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { QueryBus } from "@nestjs/cqrs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer as RawWsServer, type WebSocket as RawWs } from "ws";
import { GetSessionQuery } from "../application/queries/get-session/get-session.query.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../application/ports/pikvm-gateway.port.js";
import { MediaStreamTicketService } from "./media-stream-ticket.service.js";

/**
 * A pure byte relay between the browser and PiKVM's `/api/media/ws`, deliberately built on
 * plain `ws` rather than Socket.io: Socket.io's message framing would add per-frame overhead
 * to a 60fps H.264 stream for zero benefit, since there is no application-level structure to
 * preserve here beyond "these are PiKVM's bytes, gated by an authenticated session".
 *
 * Coexists on the same HTTP server as the Socket.io gateway and the REST API. This requires
 * `noServer: true` with a manually-registered, path-checking 'upgrade' listener, NOT `ws`'s
 * own `{ server: httpServer, path }` convenience constructor -- that convenience form
 * self-attaches an 'upgrade' listener that runs for *every* upgrade request regardless of
 * path, and internally calls `abortHandshake()` (which writes an HTTP 400 directly onto the
 * raw socket and destroys it) whenever the path doesn't match. Since Node's EventEmitter
 * fires every registered 'upgrade' listener for the same event, that destroyed a socket
 * Socket.io's own engine.io handler had *already* successfully upgraded for `/rt`, corrupting
 * its frame stream (surfaced as a client-side "RSV1 must be clear" WebSocket error --
 * plausible-looking but a complete red herring; it has nothing to do with permessage-deflate
 * compression). Caught by the load test script actually connecting a real Socket.io client
 * while this class was active, which no earlier test had done -- every previous test either
 * exercised the gateway with this server disabled entirely, or exercised REST endpoints only.
 * This is exactly the core use case (video and HID input active in the same browser session)
 * a real operator depends on, so this was not a load-test-only concern.
 */
@Injectable()
export class MediaStreamServer implements OnApplicationBootstrap {
  private readonly logger = new Logger(MediaStreamServer.name);
  private static readonly PATH = "/stream";

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly ticketService: MediaStreamTicketService,
    private readonly queryBus: QueryBus,
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort
  ) {}

  onApplicationBootstrap(): void {
    // Absent in application-context-only bootstraps (e.g. the seed script), which never
    // call NestFactory.create() with an HTTP adapter. Nothing to attach to in that case.
    if (!this.httpAdapterHost.httpAdapter) return;

    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();
    const wss = new RawWsServer({ noServer: true });

    httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(req.url ?? "", "http://internal").pathname;
      if (pathname !== MediaStreamServer.PATH) return; // not ours -- leave the socket untouched for other listeners (Socket.io's)

      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });

    wss.on("connection", (socket, request) => {
      this.handleConnection(socket, request.url ?? "").catch((err: Error) => {
        this.logger.error(`Media stream connection failed: ${err.message}`);
        socket.close(1011);
      });
    });
    this.logger.log(`Media stream relay listening on ${MediaStreamServer.PATH}`);
  }

  private async handleConnection(browserSocket: RawWs, requestUrl: string): Promise<void> {
    const ticket = new URL(requestUrl, "http://internal").searchParams.get("ticket");
    if (!ticket) {
      browserSocket.close(4401, "Missing ticket");
      return;
    }

    const claims = this.ticketService.verify(ticket); // throws UnauthorizedError -> caught by caller
    const session = await this.queryBus.execute(new GetSessionQuery(claims.sessionId, claims.tenantId));
    if (!session.isParticipant(claims.sub)) {
      browserSocket.close(4403, "Not a participant");
      return;
    }

    const relay = this.pikvm.createMediaRelay(session.equipmentId);
    if (!relay) {
      browserSocket.close(1011, "Device not connected");
      return;
    }

    relay.onDeviceMessage((data, isBinary) => {
      if (browserSocket.readyState === browserSocket.OPEN) {
        browserSocket.send(data, { binary: isBinary });
      }
    });
    relay.on("close", () => browserSocket.close());
    relay.on("error", () => browserSocket.close(1011));

    browserSocket.on("message", (data, isBinary) => relay.sendToDevice(data, isBinary));
    browserSocket.on("close", () => relay.disconnect());

    relay.connect();
  }
}
