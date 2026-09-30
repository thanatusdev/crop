import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  ClinicDayStringSchema,
  CreateQueueEntryRequestSchema,
  ReorderQueueRequestSchema,
  UpdatePreparationStatusRequestSchema,
  UpdateQueueEntryDetailsRequestSchema,
  UpdateQueueStatusRequestSchema,
  UpdateTeleoperationNotesRequestSchema,
  UserRole,
  type AccessTokenClaims,
  type CreateQueueEntryRequest,
  type ReorderQueueRequest,
  type UpdatePreparationStatusRequest,
  type UpdateQueueEntryDetailsRequest,
  type UpdateQueueStatusRequest,
  type UpdateTeleoperationNotesRequest,
} from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { ValidationError } from "../../../shared/domain/errors.js";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../iam/presentation/guards/roles.guard.js";
import { Roles } from "../../iam/presentation/decorators/roles.decorator.js";
import { CurrentUser } from "../../iam/presentation/decorators/current-user.decorator.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../iam/application/ports/user-repository.port.js";
import { CreateQueueEntryCommand } from "../application/commands/create-queue-entry/create-queue-entry.command.js";
import { UpdateQueueStatusCommand } from "../application/commands/update-queue-status/update-queue-status.command.js";
import { UpdatePreparationStatusCommand } from "../application/commands/update-preparation-status/update-preparation-status.command.js";
import { ReorderQueueCommand } from "../application/commands/reorder-queue/reorder-queue.command.js";
import { UpdateQueueEntryDetailsCommand } from "../application/commands/update-queue-entry-details/update-queue-entry-details.command.js";
import { UpdateTeleoperationNotesCommand } from "../application/commands/update-teleoperation-notes/update-teleoperation-notes.command.js";
import { ListQueueByEquipmentQuery } from "../application/queries/list-queue-by-equipment/list-queue-by-equipment.query.js";
import { GetQueueEntryQuery } from "../application/queries/get-queue-entry/get-queue-entry.query.js";
import { GetQueueEntryTimelineQuery } from "../application/queries/get-queue-entry-timeline/get-queue-entry-timeline.query.js";
import { QueueEntry } from "../domain/queue-entry.entity.js";
import { toQueueEntryDto } from "./queue.dto.js";

/** Batches `detailsUpdatedByUserId` -> display-name resolution for one or more entries --
 * the same "resolve names at the presentation boundary, keep the mapper pure" shape
 * `toSessionDto`/`SessionParticipantNameService` already established, just without a
 * dedicated service class for a single-field, single-repository lookup. */
async function resolveDetailsUpdatedByNames(
  users: UserRepositoryPort,
  entries: readonly QueueEntry[]
): Promise<Map<string, string | null>> {
  const userIds = [...new Set(entries.map((entry) => entry.detailsUpdatedByUserId).filter((id): id is string => !!id))];
  if (userIds.length === 0) return new Map();
  const names = await users.summarizeDisplayNames(userIds);
  return new Map(userIds.map((id) => [id, names[id] ?? null]));
}

// This module had no @Roles at all until the clinic role family (NURSING, LOCAL_SUPERVISOR,
// LOCAL_IT, CLINIC_ADMIN -- see packages/shared/src/roles.ts) was introduced: any
// authenticated user, any role, could add/list/transition another tenant's patient queue
// (tenant isolation was still enforced in the handlers -- see CreateQueueEntryHandler -- but
// role was not).
//
// DashboardPage renders every equipment card's patient-queue block, and fetches it via
// GET /queue, unconditionally for whichever role is logged in ("/" is still every existing
// role's landing page -- see role-routes.ts) -- CLINIC_ADMIN and OPERATOR both depend on this
// today (queue-tenant-isolation.e2e.spec.ts exercises CLINIC_ADMIN; the OPERATOR session-start
// flow reads the queue to find the next WAITING patient). Restricting this module can't
// regress either of those, so the list below is every existing role plus the new clinic ones
// that should manage the queue (NURSING, LOCAL_SUPERVISOR) -- LOCAL_IT is the one deliberate
// exclusion, since equipment maintenance staff has no legitimate reason to read or write
// patient identities.
@Controller("queue")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(
  UserRole.PLATFORM_ADMIN,
  UserRole.CLINIC_ADMIN,
  UserRole.LOCAL_SUPERVISOR,
  UserRole.NURSING,
  UserRole.OPERATOR,
  UserRole.OPERATIONAL_SUPERVISOR,
  UserRole.OPERATOR_ADMIN,
  UserRole.AUDITOR
)
export class QueueController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort
  ) {}

  @Post()
  async create(
    @CurrentUser() user: AccessTokenClaims,
    @Body(new ZodValidationPipe(CreateQueueEntryRequestSchema)) body: CreateQueueEntryRequest
  ) {
    const entry: QueueEntry = await this.commandBus.execute(
      new CreateQueueEntryCommand(
        user.tenantId,
        user.sub,
        body.equipmentId,
        body.patientFirstName,
        body.scheduledAt ? new Date(body.scheduledAt) : null,
        user
      )
    );
    return toQueueEntryDto(entry);
  }

  // `date` (YYYY-MM-DD, a clinic-local calendar day) is optional and never defaulted to
  // "today" here -- DashboardPage's own patient-queue table and the session-start "find the
  // next WAITING patient" flow both call this with no `date` at all and need every entry
  // regardless of day; only NursingPage's day-view passes it explicitly. See
  // ListQueueByEquipmentQuery's own docstring.
  @Get()
  async list(@CurrentUser() user: AccessTokenClaims, @Query("equipmentId") equipmentId: string, @Query("date") date?: string) {
    if (date !== undefined && !ClinicDayStringSchema.safeParse(date).success) {
      throw new ValidationError("date must be YYYY-MM-DD");
    }
    const entries: QueueEntry[] = await this.queryBus.execute(new ListQueueByEquipmentQuery(equipmentId, user.tenantId, date, user));
    const names = await resolveDetailsUpdatedByNames(this.users, entries);
    return entries.map((entry) => toQueueEntryDto(entry, entry.detailsUpdatedByUserId ? names.get(entry.detailsUpdatedByUserId) ?? null : null));
  }

  // Added alongside the nursing preparation feature -- SessionPage (the Biomedical's
  // console) reads its own queue entry by id (session.queueEntryId) rather than re-fetching
  // and filtering the whole per-equipment list. Inherits the class-level @Roles: everyone
  // who can list the queue can read one entry from it.
  @Get(":id")
  async getOne(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    const entry: QueueEntry = await this.queryBus.execute(new GetQueueEntryQuery(id, user.tenantId, user));
    const names = await resolveDetailsUpdatedByNames(this.users, [entry]);
    return toQueueEntryDto(entry, entry.detailsUpdatedByUserId ? names.get(entry.detailsUpdatedByUserId) ?? null : null);
  }

  // The nursing screen's per-exam activity panel -- see GetQueueEntryTimelineQuery's own
  // docstring for why this is a resource-scoped route here rather than a widening of
  // AuditController's @Roles (which deliberately excludes NURSING). Inherits the
  // class-level @Roles: everyone who can read this queue entry can read its timeline.
  @Get(":id/timeline")
  async timeline(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    return this.queryBus.execute(new GetQueueEntryTimelineQuery(id, user.tenantId, user));
  }

  @Post(":id/status")
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateStatus(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateQueueStatusRequestSchema)) body: UpdateQueueStatusRequest
  ): Promise<void> {
    await this.commandBus.execute(new UpdateQueueStatusCommand(user.tenantId, user.sub, id, body.status, user));
  }

  // Method-level @Roles, deliberately narrower than the class-level set: asserting a
  // nursing preparation signal ("Paciente Posicionado" / "Injetado" / "Paciente Liberado")
  // is an in-room clinical act, not the general queue read/transition access every
  // clinic/operator role above gets. RolesGuard's reflector.getAllAndOverride checks the
  // handler before the class, so this wins over the class-level @Roles for this one route.
  @Post(":id/preparation")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.NURSING, UserRole.LOCAL_SUPERVISOR, UserRole.CLINIC_ADMIN, UserRole.PLATFORM_ADMIN)
  async updatePreparation(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdatePreparationStatusRequestSchema)) body: UpdatePreparationStatusRequest
  ): Promise<void> {
    await this.commandBus.execute(new UpdatePreparationStatusCommand(user.tenantId, user.sub, id, body.status));
  }

  // Method-level @Roles, same narrower set as :id/preparation above and for the same
  // reason: setting a room's patient priority is a clinical/local-management act, not the
  // general queue read/transition access every operator-side role gets from the class-level
  // @Roles. OPERATOR only ever *reads* the queue (to find the next WAITING patient when
  // starting a session) -- it has no legitimate reason to reorder it.
  @Post("reorder")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.NURSING, UserRole.LOCAL_SUPERVISOR, UserRole.CLINIC_ADMIN, UserRole.PLATFORM_ADMIN)
  async reorder(
    @CurrentUser() user: AccessTokenClaims,
    @Body(new ZodValidationPipe(ReorderQueueRequestSchema)) body: ReorderQueueRequest
  ): Promise<void> {
    await this.commandBus.execute(new ReorderQueueCommand(user.tenantId, user.sub, body.equipmentId, body.orderedIds));
  }

  // Same narrower @Roles as reorder/preparation above -- a patient's exam-detail fields
  // (weight, sex, clinical notes) are the nurse's own editable form, not general queue
  // transition access.
  @Patch(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.NURSING, UserRole.LOCAL_SUPERVISOR, UserRole.CLINIC_ADMIN, UserRole.PLATFORM_ADMIN)
  async updateDetails(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateQueueEntryDetailsRequestSchema)) body: UpdateQueueEntryDetailsRequest
  ): Promise<void> {
    // Same three-way undefined/null/value convention as the schema itself: undefined ("key
    // omitted") must survive as undefined here too, not get coerced by a `? :` that can't
    // tell an empty string apart from "not provided" -- see UpdateQueueEntryDetailsCommand's
    // own docstring.
    const scheduledAt = body.scheduledAt === undefined ? undefined : body.scheduledAt === null ? null : new Date(body.scheduledAt);
    await this.commandBus.execute(
      new UpdateQueueEntryDetailsCommand(
        user.tenantId,
        user.sub,
        id,
        body.examDescription,
        body.contrastRequired,
        body.patientSex,
        body.patientWeightKg,
        scheduledAt,
        body.preparationNotes,
        body.fastingConfirmed,
        body.fastingHours,
        body.creatinineMgDl,
        body.allergyStatus,
        body.allergyNotes,
        body.contrastVolumeMl
      )
    );
  }

  // Method-level @Roles, deliberately the operator side of the exact same split
  // `:id/preparation` above draws for the nursing side: this is the remote operator's own
  // procedural note, not the general queue read/transition access every clinic/operator
  // role gets from the class-level @Roles, and not the nurse's exam-details form either --
  // see UpdateTeleoperationNotesHandler's own docstring for why the two fields have two
  // separate write paths that must never cross.
  @Patch(":id/teleoperation-notes")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.OPERATOR, UserRole.OPERATIONAL_SUPERVISOR, UserRole.OPERATOR_ADMIN, UserRole.PLATFORM_ADMIN)
  async updateTeleoperationNotes(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateTeleoperationNotesRequestSchema)) body: UpdateTeleoperationNotesRequest
  ): Promise<void> {
    await this.commandBus.execute(
      new UpdateTeleoperationNotesCommand(user.tenantId, user.sub, id, body.teleoperationNotes, user)
    );
  }
}

