import type { AllergyStatus, PatientSex } from "@crop/shared";

/** The nurse's "Salvar Alterações deste Paciente" form. Every field mirrors
 * UpdateQueueEntryDetailsRequest's own "undefined = leave alone, null = clear" convention --
 * see that schema's docstring in packages/shared/src/contracts/queue.ts. The six
 * questionnaire fields (fastingConfirmed onward) follow the same convention as the five
 * original exam-detail fields above them -- this command grew in place rather than gaining
 * a second, differently-shaped constructor for "the new half" of the same form. */
export class UpdateQueueEntryDetailsCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly queueEntryId: string,
    public readonly examDescription: string | null | undefined,
    public readonly contrastRequired: boolean | undefined,
    public readonly patientSex: PatientSex | null | undefined,
    public readonly patientWeightKg: number | null | undefined,
    public readonly scheduledAt: Date | null | undefined,
    public readonly preparationNotes: string | null | undefined,
    public readonly fastingConfirmed: boolean | undefined,
    public readonly fastingHours: number | null | undefined,
    public readonly creatinineMgDl: number | null | undefined,
    public readonly allergyStatus: AllergyStatus | null | undefined,
    public readonly allergyNotes: string | null | undefined,
    public readonly contrastVolumeMl: number | null | undefined,
    public readonly metforminUse: boolean | null | undefined,
    public readonly anticoagulantUse: boolean | null | undefined
  ) {}
}
