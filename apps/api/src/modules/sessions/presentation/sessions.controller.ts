import { Body, Controller, Get, Inject, Param, Post, Res, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import type { Response } from "express";
import { StartSessionRequestSchema, UserRole, type AccessTokenClaims, type StartSessionRequest } from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { CurrentUser } from "../../iam/presentation/decorators/current-user.decorator.js";
import { ForbiddenError, NotFoundError } from "../../../shared/domain/errors.js";
import { StartSessionCommand } from "../application/commands/start-session/start-session.command.js";
import { EndSessionCommand } from "../application/commands/end-session/end-session.command.js";
import { ReleaseAllInputCommand } from "../application/commands/release-all-input/release-all-input.command.js";
import { GetActiveSessionsQuery } from "../application/queries/get-active-sessions/get-active-sessions.query.js";
import { GetSessionQuery } from "../application/queries/get-session/get-session.query.js";
import { ListSessionSnapshotsQuery } from "../application/queries/list-session-snapshots/list-session-snapshots.query.js";
import { SNAPSHOT_STORAGE, type SnapshotStoragePort } from "../application/ports/snapshot-storage.port.js";
import { Session } from "../domain/session.entity.js";
import { MediaStreamTicketService } from "../infrastructure/media-stream-ticket.service.js";
import { SessionsGateway } from "./sessions.gateway.js";
import { toSessionDto } from "./session.dto.js";

const REPLAY_ALLOWED_ROLES: readonly UserRole[] = [UserRole.AUDITOR, UserRole.SUPERVISOR, UserRole.CLINIC_ADMIN, UserRole.PLATFORM_ADMIN];

/**
 * Takeover and print-text are deliberately WebSocket-only (see SessionsGateway), not
 * duplicated here as REST endpoints: both need to broadcast a live update to every
 * participant in the session room, and having two entry points for the same state change
 * is exactly the kind of divergence that leads to "it worked via the button but not via
 * curl" bugs. Session lifecycle (start/end) and reads stay REST since they don't need that.
 */
@Controller("sessions")
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly ticketService: MediaStreamTicketService,
    private readonly gateway: SessionsGateway,
    @Inject(SNAPSHOT_STORAGE) private readonly snapshotStorage: SnapshotStoragePort
  ) {}

  @Post()
  async start(
    @CurrentUser() user: AccessTokenClaims,
    @Body(new ZodValidationPipe(StartSessionRequestSchema)) body: StartSessionRequest
  ) {
    const session = await this.commandBus.execute(
      new StartSessionCommand(user.tenantId, user.sub, body.equipmentId, body.queueEntryId ?? null)
    );
    return toSessionDto(session);
  }

  @Post(":id/end")
  async end(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    await this.commandBus.execute(new EndSessionCommand(id, user.tenantId, user.sub));
    this.gateway.broadcastSessionEnded(id);
  }

  /** Emergency escape hatch: releases stuck input without ending the session. See ReleaseAllInputHandler. */
  @Post(":id/release-all")
  async releaseAll(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    await this.commandBus.execute(new ReleaseAllInputCommand(id, user.tenantId, user.sub));
  }

  @Get("active")
  async listActive(@CurrentUser() user: AccessTokenClaims) {
    const sessions: Session[] = await this.queryBus.execute(new GetActiveSessionsQuery(user.tenantId));
    return sessions.map(toSessionDto);
  }

  @Get(":id")
  async getOne(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    const session = await this.queryBus.execute(new GetSessionQuery(id, user.tenantId));
    return toSessionDto(session);
  }

  /** Issued only to a session's own operator/supervisor -- see MediaStreamTicketService. */
  @Post(":id/stream-ticket")
  async issueStreamTicket(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    const session: Session = await this.queryBus.execute(new GetSessionQuery(id, user.tenantId));
    if (!session.isParticipant(user.sub)) {
      throw new ForbiddenError("Only a participant of this session may view its video stream");
    }
    return { ticket: this.ticketService.issue(user.sub, user.tenantId, id) };
  }

  @Get(":id/snapshots")
  async listSnapshots(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    await this.assertCanReplay(user, id);
    return this.queryBus.execute(new ListSessionSnapshotsQuery(id));
  }

  @Get(":id/snapshots/:snapshotId/image")
  async getSnapshotImage(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Param("snapshotId") snapshotId: string,
    @Res() res: Response
  ): Promise<void> {
    await this.assertCanReplay(user, id);

    const snapshots = await this.queryBus.execute(new ListSessionSnapshotsQuery(id));
    const snapshot = snapshots.find((s: { id: string }) => s.id === snapshotId);
    if (!snapshot) throw new NotFoundError("SessionSnapshot", snapshotId);

    const jpeg = await this.snapshotStorage.read(snapshot.imagePath);
    res.type("image/jpeg").send(jpeg);
  }

  /** Session replay is available to participants, plus tenant auditors/supervisors/admins reviewing history.
   * The tenant check itself already happens inside GetSessionHandler; this only adds the
   * participant-or-elevated-role decision on top of an already tenant-scoped session. */
  private async assertCanReplay(user: AccessTokenClaims, sessionId: string): Promise<void> {
    const session: Session = await this.queryBus.execute(new GetSessionQuery(sessionId, user.tenantId));
    if (session.isParticipant(user.sub) || REPLAY_ALLOWED_ROLES.includes(user.role)) return;
    throw new ForbiddenError("Not authorized to view this session's replay data");
  }
}
