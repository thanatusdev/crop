import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { EncryptionService } from "../../../../../shared/infrastructure/crypto/encryption.service.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import {
  GetEquipmentConnectionSecretsQuery,
  type EquipmentConnectionSecretsResult,
} from "./get-equipment-connection-secrets.query.js";

@QueryHandler(GetEquipmentConnectionSecretsQuery)
export class GetEquipmentConnectionSecretsHandler
  implements IQueryHandler<GetEquipmentConnectionSecretsQuery, EquipmentConnectionSecretsResult>
{
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly encryption: EncryptionService
  ) {}

  async execute(query: GetEquipmentConnectionSecretsQuery): Promise<EquipmentConnectionSecretsResult> {
    const secrets = await this.equipment.getConnectionSecrets(query.equipmentId);
    if (!secrets) throw new NotFoundError("Equipment", query.equipmentId);

    return {
      baseUrl: secrets.pikvmHost,
      user: secrets.pikvmUser,
      password: this.encryption.decrypt(secrets.pikvmPasswordCiphertext),
      totpSecret: secrets.pikvmTotpSecretCiphertext
        ? this.encryption.decrypt(secrets.pikvmTotpSecretCiphertext)
        : undefined,
    };
  }
}
