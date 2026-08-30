import { io, type Socket } from "socket.io-client";
import { API_URL } from "./config.js";
import { tokenStore } from "./token-store.js";

/**
 * One Socket.io connection per SessionPage mount, authenticated via `auth.token` in the
 * handshake (see SessionsGateway.handleConnection) -- not a header, since Socket.io's
 * transport negotiation makes headers unreliable across its polling/websocket fallback.
 */
export function createSessionSocket(): Socket {
  return io(API_URL, {
    path: "/rt",
    transports: ["websocket"], // no polling fallback: a fallback transport would violate the latency budget
    auth: { token: tokenStore.getAccessToken() },
    autoConnect: false,
  });
}
