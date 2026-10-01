import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  ClinicDayStringSchema,
  CreateQueueEntryRequestSchema,
  QueueDocumentKind,
  ReorderQueueRequestSchema,
  UpdatePreparationStatusRequestSchema,
  UpdateQueueEntryDetailsRequestSchema,
  UpdateQueueStatusRequestSchema,
  UpdateTeleoperationNotesRequestSchema,
  UploadQueueDocumentRequestSchema,
  UserRole,
  type AccessTokenClaims,
  type CreateQueueEntryRequest,
  type QueueEntryDocumentDto,
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
import { QUEUE_DOCUMENT_REPOSITORY, type QueueDocumentRepositoryPort } from "../application/ports/queue-document-repository.port.js";
import { QUEUE_DOCUMENT_STORAGE, type QueueDocumentStoragePort } from "../application/ports/queue-document-storage.port.js";
import { CreateQueueEntryCommand } from "../application/commands/create-queue-entry/create-queue-entry.command.js";
import { UpdateQueueStatusCommand } from "../application/commands/update-queue-status/update-queue-status.command.js";
import { UpdatePreparationStatusCommand } from "../application/commands/update-preparation-status/update-preparation-status.command.js";
import { ReorderQueueCommand } from "../application/commands/reorder-queue/reorder-queue.command.js";
import { UpdateQueueEntryDetailsCommand } from "../application/commands/update-queue-entry-details/update-queue-entry-details.command.js";
import { UpdateTeleoperationNotesCommand } from "../application/commands/update-teleoperation-notes/update-teleoperation-notes.command.js";
import { UploadQueueDocumentCommand } from "../application/commands/upload-queue-document/upload-queue-document.command.js";
import { RemoveQueueDocumentCommand } from "../application/commands/remove-queue-document/remove-queue-document.command.js";
import { ListQueueByEquipmentQuery } from "../application/queries/list-queue-by-equipment/list-queue-by-equipment.query.js";
import { GetQueueEntryQuery } from "../application/queries/get-queue-entry/get-queue-entry.query.js";
import { GetQueueEntryTimelineQuery } from "../application/queries/get-queue-entry-timeline/get-queue-entry-timeline.query.js";
import { GetQueueDocumentQuery } from "../application/queries/get-queue-document/get-queue-document.query.js";
import { QueueEntry } from "../domain/queue-entry.entity.js";
import { QueueEntryDocument } from "../domain/queue-entry-document.entity.js";
import { toQueueEntryDto } from "./queue.dto.js";
import { toQueueEntryDocumentDto } from "./queue-document.dto.js";

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

/** Batches every listed entry's `documents`, and the uploader-name resolution for all of
 * them, in two queries total regardless of how many entries are on the page -- the same
 * "one batch per page load, not one per row" shape `resolveDetailsUpdatedByNames` above
 * already established. Returns a `Map<queueEntryId, QueueEntryDocumentDto[]>` ready for
 * `toQueueEntryDto`'s own `documents` parameter. */
async function resolveDocumentsByQueueEntry(
  documents: QueueDocumentRepositoryPort,
  users: UserRepositoryPort,
  entries: readonly QueueEntry[]
): Promise<Map<string, QueueEntryDocumentDto[]>> {
  const rows = await documents.listByQueueEntries(entries.map((entry) => entry.id));
  const uploaderIds = [...new Set(rows.map((row) => row.uploadedByUserId))];
  const names = uploaderIds.length > 0 ? await users.summarizeDisplayNames(uploaderIds) : {};

  const byEntry = new Map<string, QueueEntryDocumentDto[]>();
  for (const row of rows) {
    const dto = toQueueEntryDocumentDto(row, names[row.uploadedByUserId] ?? null);
    const existing = byEntry.get(row.queueEntryId);
    if (existing) existing.push(dto);
    else byEntry.set(row.queueEntryId, [dto]);
  }
  return byEntry;
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
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(QUEUE_DOCUMENT_REPOSITORY) private readonly documents: QueueDocumentRepositoryPort,
    @Inject(QUEUE_DOCUMENT_STORAGE) private readonly documentStorage: QueueDocumentStoragePort,
    private readonly config: ConfigService
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
    // A brand-new entry has no documents yet -- no need to hit resolveDocumentsByQueueEntry
    // for a list that is guaranteed empty.
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
    const documentsByEntry = await resolveDocumentsByQueueEntry(this.documents, this.users, entries);
    return entries.map((entry) =>
      toQueueEntryDto(
        entry,
        entry.detailsUpdatedByUserId ? names.get(entry.detailsUpdatedByUserId) ?? null : null,
        documentsByEntry.get(entry.id) ?? []
      )
    );
  }

  // Added alongside the nursing preparation feature -- SessionPage (the Biomedical's
  // console) reads its own queue entry by id (session.queueEntryId) rather than re-fetching
  // and filtering the whole per-equipment list. Inherits the class-level @Roles: everyone
  // who can list the queue can read one entry from it.
  @Get(":id")
  async getOne(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string) {
    const entry: QueueEntry = await this.queryBus.execute(new GetQueueEntryQuery(id, user.tenantId, user));
    const names = await resolveDetailsUpdatedByNames(this.users, [entry]);
    const documentsByEntry = await resolveDocumentsByQueueEntry(this.documents, this.users, [entry]);
    return toQueueEntryDto(
      entry,
      entry.detailsUpdatedByUserId ? names.get(entry.detailsUpdatedByUserId) ?? null : null,
      documentsByEntry.get(entry.id) ?? []
    );
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
        body.contrastVolumeMl,
        body.metforminUse,
        body.anticoagulantUse
      )
    );
  }

  // Method-level @Roles, same narrower nurse-side set as :id/preparation and the PATCH
  // above: uploading a physician's order is part of the same exam-detail authorization
  // boundary, not general queue read/transition access. `UploadQueueDocumentHandler`'s own
  // `assertDetailsEditable()` call is the real status gate; the hard 30MB ceiling here is
  // Multer's own static limit (resolved before `ConfigService` exists, same constraint
  // `ChatController`'s identical comment explains), re-checked against the configurable,
  // lower `QUEUE_DOCUMENT_MAX_BYTES` default inside the handler body.
  @Post(":id/documents")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 30 * 1024 * 1024 } }))
  @Roles(UserRole.NURSING, UserRole.LOCAL_SUPERVISOR, UserRole.CLINIC_ADMIN, UserRole.PLATFORM_ADMIN)
  async uploadDocument(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Body() body: unknown,
    @UploadedFile() file?: Express.Multer.File
  ) {
    if (!file) throw new ValidationError("A file is required");

    const maxBytes = this.config.get<number>("QUEUE_DOCUMENT_MAX_BYTES", 20 * 1024 * 1024);
    if (file.size > maxBytes) {
      throw new ValidationError(`Document exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit`);
    }
    if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(file.mimetype)) {
      throw new ValidationError(`Document type "${file.mimetype}" is not allowed`);
    }

    // Multipart text fields arrive as strings, same reason ChatController's identical
    // `SendExamMessageRequestSchema.safeParse(body)` can't use ZodValidationPipe either.
    const parsed = UploadQueueDocumentRequestSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const document: QueueEntryDocument = await this.commandBus.execute(
      new UploadQueueDocumentCommand(
        user.tenantId,
        user.sub,
        id,
        parsed.data.kind ?? QueueDocumentKind.PEDIDO_MEDICO,
        file.originalname,
        file.mimetype,
        file.buffer
      )
    );
    // The uploader is always the caller themselves (UploadQueueDocumentCommand stamps
    // `uploadedByUserId: user.sub`) -- one lookup, not the batched resolveDocumentsByQueueEntry
    // shape `list`/`getOne` use, since there is exactly one name to resolve here.
    const names = await this.users.summarizeDisplayNames([user.sub]);
    return toQueueEntryDocumentDto(document, names[user.sub] ?? null);
  }

  // Same narrower @Roles as the upload route above -- see RemoveQueueDocumentCommand's own
  // docstring for why both ids are required. POST, not DELETE: this module (like every
  // other controller in this codebase) has no @Delete route at all -- every destructive
  // action is a POST to a sub-resource, so this follows that convention rather than
  // introducing the first exception to it.
  @Post(":id/documents/:docId/remove")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.NURSING, UserRole.LOCAL_SUPERVISOR, UserRole.CLINIC_ADMIN, UserRole.PLATFORM_ADMIN)
  async removeDocument(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string, @Param("docId") docId: string): Promise<void> {
    await this.commandBus.execute(new RemoveQueueDocumentCommand(user.tenantId, user.sub, id, docId));
  }

  // Inherits the class-level @Roles, deliberately NOT narrowed to the nurse-side set the two
  // routes above use -- the remote operator (OPERATOR/OPERATIONAL_SUPERVISOR/OPERATOR_ADMIN)
  // needs to read what was ordered, and has no write access to this list at all. See
  // GetQueueDocumentHandler's own docstring for the full reasoning, including why this is
  // the one document route with no `assertDetailsEditable()` gate. Resolves the file through
  // this row's own tenancy/scope check first, never from a client-supplied path -- the same
  // discipline `ChatController.getAttachment`/`SessionsController.getSnapshotImage` already
  // follow.
  @Get(":id/documents/:docId/content")
  async getDocumentContent(
    @CurrentUser() user: AccessTokenClaims,
    @Param("id") id: string,
    @Param("docId") docId: string,
    @Res() res: Response
  ): Promise<void> {
    const document: QueueEntryDocument = await this.queryBus.execute(new GetQueueDocumentQuery(id, docId, user.tenantId, user));
    const data = await this.documentStorage.read(document.path);
    res
      .type(document.mimeType)
      .set("Content-Disposition", `inline; filename="${encodeURIComponent(document.filename)}"`)
      .send(data);
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

