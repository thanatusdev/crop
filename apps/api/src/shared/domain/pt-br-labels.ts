import {
  AgreementStatus,
  PreparationStatus,
  QueueStatus,
  SessionStatus,
  TenantType,
  UserRole,
} from "@crop/shared";

/**
 * pt-BR wording for the enum values and resource names that error messages interpolate.
 *
 * The product is pt-BR only and every web screen renders the API's `message` verbatim, so error
 * text is written in Portuguese at the source rather than translated by the client. These maps
 * exist so a message such as "Este contrato está pendente" never leaks a raw `PENDING` or an
 * English class name like `OperatorAgreement` into that text.
 */

export const ROLE_LABELS_PT_BR: Record<UserRole, string> = {
  [UserRole.PLATFORM_ADMIN]: "Administrador da Plataforma",
  [UserRole.CLINIC_ADMIN]: "Gestor de Clínica",
  [UserRole.LOCAL_SUPERVISOR]: "Supervisor",
  [UserRole.NURSING]: "Enfermagem",
  [UserRole.LOCAL_IT]: "TI Local",
  [UserRole.OPERATOR_ADMIN]: "Administrador da Operadora",
  [UserRole.OPERATIONAL_SUPERVISOR]: "Supervisor Operacional",
  [UserRole.OPERATOR]: "Operador Biomédico",
  [UserRole.AUDITOR]: "Auditor",
};

export const TENANT_TYPE_LABELS_PT_BR: Record<TenantType, string> = {
  [TenantType.CLINIC]: "clínica",
  [TenantType.OPERATOR_PROVIDER]: "empresa operadora",
  [TenantType.PLATFORM]: "plataforma",
};

export const AGREEMENT_STATUS_LABELS_PT_BR: Record<AgreementStatus, string> = {
  [AgreementStatus.PENDING]: "pendente",
  [AgreementStatus.ACTIVE]: "ativo",
  [AgreementStatus.REJECTED]: "recusado",
  [AgreementStatus.REVOKED]: "encerrado",
};

export const QUEUE_STATUS_LABELS_PT_BR: Record<QueueStatus, string> = {
  [QueueStatus.WAITING]: "aguardando",
  [QueueStatus.IN_PROGRESS]: "em andamento",
  [QueueStatus.DONE]: "concluído",
  [QueueStatus.CANCELLED]: "cancelado",
};

export const PREPARATION_STATUS_LABELS_PT_BR: Record<PreparationStatus, string> = {
  [PreparationStatus.NOT_STARTED]: "não iniciado",
  [PreparationStatus.POSITIONED]: "posicionado",
  [PreparationStatus.INJECTED]: "injetado",
  [PreparationStatus.RELEASED]: "liberado",
};

export const SESSION_STATUS_LABELS_PT_BR: Record<SessionStatus, string> = {
  [SessionStatus.PENDING]: "pendente",
  [SessionStatus.ACTIVE]: "ativa",
  [SessionStatus.ENDED]: "encerrada",
  [SessionStatus.ABORTED]: "interrompida",
};

/** Resource names passed to `NotFoundError`, worded as the subject of "não encontrado(a)". */
export const RESOURCE_LABELS_PT_BR: Record<string, string> = {
  Equipment: "Equipamento não encontrado",
  ExamMessage: "Mensagem não encontrada",
  OperatorAgreement: "Contrato não encontrado",
  QueueEntry: "Paciente da fila não encontrado",
  QueueEntryDocument: "Documento não encontrado",
  Session: "Sessão não encontrada",
  SessionSnapshot: "Captura de tela não encontrada",
  Tenant: "Organização não encontrada",
  Unit: "Unidade não encontrada",
  User: "Usuário não encontrado",
};

/** Looks up a label without letting an unknown value break the message. */
export function labelOf<K extends string>(labels: Record<K, string>, value: K | string): string {
  return (labels as Record<string, string>)[value] ?? value;
}
