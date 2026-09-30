import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import { ExamMessageSentEvent } from "../../../chat/application/events/exam-message-sent.event.js";
import { SessionsGateway } from "../../presentation/sessions.gateway.js";

/**
 * Lives here, not in `ChatModule`, for the same anti-cycle reason
 * `BroadcastQueueUpdatedHandler` does -- see that handler's own docstring. `ChatModule` has
 * no idea this handler exists; it only ever publishes `ExamMessageSentEvent`.
 */
@EventsHandler(ExamMessageSentEvent)
export class BroadcastExamMessageHandler implements IEventHandler<ExamMessageSentEvent> {
  constructor(private readonly gateway: SessionsGateway) {}

  handle(event: ExamMessageSentEvent): void {
    this.gateway.broadcastExamMessage(event.equipmentId, event.message);
  }
}
