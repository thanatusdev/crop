import { Injectable } from "@nestjs/common";
import type { ControlSuspension, SessionRuntimePort } from "../application/ports/session-runtime.port.js";

@Injectable()
export class InMemorySessionRuntimeRegistry implements SessionRuntimePort {
  private readonly controllerBySession = new Map<string, string>();
  private readonly lastActivityBySession = new Map<string, number>();
  private readonly suspensionBySession = new Map<string, ControlSuspension>();

  setController(sessionId: string, userId: string): void {
    this.controllerBySession.set(sessionId, userId);
  }

  getController(sessionId: string): string | undefined {
    const controller = this.controllerBySession.get(sessionId);
    if (controller !== undefined && this.suspensionBySession.get(sessionId)?.userIds.includes(controller)) return undefined;
    return controller;
  }

  suspendControl(sessionId: string, suspension: ControlSuspension): void {
    const previous = this.suspensionBySession.get(sessionId);
    const userIds = [...new Set([...(previous?.userIds ?? []), ...suspension.userIds])];
    this.suspensionBySession.set(sessionId, { ...suspension, userIds });
  }

  getSuspension(sessionId: string): ControlSuspension | undefined {
    return this.suspensionBySession.get(sessionId);
  }

  clear(sessionId: string): void {
    this.controllerBySession.delete(sessionId);
    this.lastActivityBySession.delete(sessionId);
    this.suspensionBySession.delete(sessionId);
  }

  recordActivity(sessionId: string): void {
    this.lastActivityBySession.set(sessionId, Date.now());
  }

  getLastActivityAt(sessionId: string): number | undefined {
    return this.lastActivityBySession.get(sessionId);
  }
}
