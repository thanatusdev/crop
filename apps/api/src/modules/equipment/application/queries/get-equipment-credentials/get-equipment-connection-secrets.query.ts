export class GetEquipmentConnectionSecretsQuery {
  constructor(public readonly equipmentId: string) {}
}

/** Decrypted, ready to hand to @crop/pikvm. Never logged, never leaves the process. */
export interface EquipmentConnectionSecretsResult {
  baseUrl: string;
  user: string;
  password: string;
  totpSecret?: string;
}
