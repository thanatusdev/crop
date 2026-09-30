import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../../../equipment/application/ports/equipment-repository.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { EXAM_MESSAGE_REPOSITORY, type ExamMessageRepositoryPort } from "../../ports/exam-message-repository.port.js";
import { ExamMessage } from "../../../domain/exam-message.entity.js";
import { GetExamMessageQuery } from "./get-exam-message.query.js";

@QueryHandler(GetExamMessageQuery)
export class GetExamMessageHandler implements IQueryHandler<GetExamMessageQuery, ExamMessage> {
  constructor(
    @Inject(EXAM_MESSAGE_REPOSITORY) private readonly messages: ExamMessageRepositoryPort,
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly operatorAccess: OperatorAccessService
  ) {}

  async execute(query: GetExamMessageQuery): Promise<ExamMessage> {
    const message = await this.messages.findById(query.messageId);
    if (!message) throw new NotFoundError("ExamMessage", query.messageId);
    if (!message.belongsToTenant(query.tenantId)) {
      throw new ForbiddenError("This message does not belong to your tenant");
    }

    const equipment = await this.equipment.findById(message.equipmentId);
    if (!equipment) throw new NotFoundError("Equipment", message.equipmentId);
    await this.operatorAccess.assertCanReachEquipment(query.actor, {
      id: equipment.id,
      tenantId: equipment.tenantId,
      unitId: equipment.unitId,
    });

    return message;
  }
}
