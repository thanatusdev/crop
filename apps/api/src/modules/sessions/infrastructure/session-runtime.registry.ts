import { Injectable } from "@nestjs/common";
import type { SessionRuntimePort } from "../application/ports/session-runtime.port.js";

@Injectable()
export class InMemorySessionRuntimeRegistry implements SessionRuntimePort {
  private readonly controllerBySession = new Map<string, string>();
  private readonly lastActivityBySession = new Map<string, number>();

  setController(sessionId: string, userId: string): void {
    this.controllerBySession.set(sessionId, userId);
  }

  getController(sessionId: string): string | undefined {
    return this.controllerBySession.get(sessionId);
  }

  clear(sessionId: string): void {
    this.controllerBySession.delete(sessionId);
    this.lastActivityBySession.delete(sessionId);
  }

  recordActivity(sessionId: string): void {
    this.lastActivityBySession.set(sessionId, Date.now());
  }

  getLastActivityAt(sessionId: string): number | undefined {
    return this.lastActivityBySession.get(sessionId);
  }
}
