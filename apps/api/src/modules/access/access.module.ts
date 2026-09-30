import { Module } from "@nestjs/common";

import { AGREEMENT_REPOSITORY } from "./application/ports/agreement-repository.port.js";
import { PrismaAgreementRepository } from "./infrastructure/prisma-agreement.repository.js";
import { OperatorAccessService } from "./application/operator-access.service.js";

/**
 * The *read* half of the clinic<->operator contract: the agreement repository and the service that
 * answers "may this actor reach this clinic / this equipment".
 *
 * Split from `AgreementsModule` (which owns the commands and the HTTP surface) to break a genuine
 * dependency cycle, not for tidiness. `AgreementsModule` has a controller, so it needs IamModule's
 * guards; but IamModule itself needs agreement reads, because `SwitchActiveClinicHandler` and
 * `ListMyClinicsHandler` have to know which clinics a contracted operator may enter. Iam ->
 * Agreements -> Iam is unresolvable without a `forwardRef`, which would hide the cycle rather than
 * remove it.
 *
 * This module therefore depends on nothing but Prisma (globally provided). Everything that needs
 * to *ask* about access imports it: IamModule, UnitsModule, EquipmentModule, QueueModule,
 * SessionsModule and AgreementsModule. Nothing here depends on them, so the edge stays
 * one-directional in every case -- the same discipline `PrismaUnitRepository` follows when it
 * reads the `equipment` table directly instead of importing EquipmentModule.
 */
@Module({
  providers: [{ provide: AGREEMENT_REPOSITORY, useClass: PrismaAgreementRepository }, OperatorAccessService],
  exports: [AGREEMENT_REPOSITORY, OperatorAccessService],
})
export class AccessModule {}
