import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { ConfigService } from "@nestjs/config";
import { clinicDayBounds, DEFAULT_CLINIC_TIME_ZONE } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../../../equipment/application/ports/equipment-repository.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { EXAM_MESSAGE_REPOSITORY, type ExamMessageRepositoryPort } from "../../ports/exam-message-repository.port.js";
import { ExamMessage } from "../../../domain/exam-message.entity.js";
import { ListExamMessagesQuery } from "./list-exam-messages.query.js";

/** Backs `GET /chat/messages` -- the initial-load fetch; new messages after that arrive live
 * over the socket (`EXAM_MESSAGE_CREATED`). Unlike sending (a REST write of its own now, see
 * `SendExamMessageHandler`'s own docstring), this re-derives the same tenant + agreement-
 * scope checks `GetEquipmentHandler` applies -- a contracted operator (or, since this is the
 * one exam-support surface nursing has never needed a session to reach, a clinic's own
 * nursing staff) changing the `equipmentId` query parameter to a room outside their scope is
 * exactly the read this guards against. */
@QueryHandler(ListExamMessagesQuery)
export class ListExamMessagesHandler implements IQueryHandler<ListExamMessagesQuery, ExamMessage[]> {
  constructor(
    @Inject(EXAM_MESSAGE_REPOSITORY) private readonly messages: ExamMessageRepositoryPort,
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly operatorAccess: OperatorAccessService,
    private readonly config: ConfigService
  ) {}

  async execute(query: ListExamMessagesQuery): Promise<ExamMessage[]> {
    const equipment = await this.equipment.findById(query.equipmentId);
    if (!equipment) throw new NotFoundError("Equipment", query.equipmentId);
    if (!equipment.belongsToTenant(query.tenantId)) {
      throw new ForbiddenError("Equipment does not belong to your tenant");
    }
    if (query.actor) {
      await this.operatorAccess.assertCanReachEquipment(query.actor, {
        id: equipment.id,
        tenantId: equipment.tenantId,
        unitId: equipment.unitId,
      });
    }

    const createdBetween = query.day
      ? clinicDayBounds(query.day, this.config.get<string>("CLINIC_TIME_ZONE", DEFAULT_CLINIC_TIME_ZONE))
      : undefined;
    return this.messages.listByEquipment(query.equipmentId, { createdBetween });
  }
}
