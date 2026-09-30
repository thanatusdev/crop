/**
 * Seeds demo data for the CROP MVP by bootstrapping the real Nest application context and
 * dispatching the same commands the HTTP API would -- this is deliberately not a raw SQL
 * script or a Prisma-only shortcut. Running it exercises the exact same validation, MFA
 * enrollment, and encryption paths a real signup would, so the seeded accounts are
 * guaranteed to behave identically to ones created through the UI.
 *
 * Requires apps/api to be built first (`pnpm --filter @crop/api build`), since it imports
 * the compiled AppModule -- see the comment in db:seed in the root package.json for why.
 */
import { NestFactory } from "@nestjs/core";
import { CommandBus } from "@nestjs/cqrs";
import * as OTPAuth from "otpauth";
import { TargetOs, MouseMode, ExamModality, EstablishmentType, TenantType, UserRole, PatientSex, AllergyStatus, clinicTimeToUtcIso, todayClinicDayString, requiresClinicAssignment } from "@crop/shared";
import { DEMO_PASSWORD } from "./demo-password.js";
import { AppModule } from "../../apps/api/dist/app.module.js";
import { RegisterUserCommand } from "../../apps/api/dist/modules/iam/application/commands/register-user/register-user.command.js";
import { ConfirmMfaEnrollmentCommand } from "../../apps/api/dist/modules/iam/application/commands/enroll-mfa/confirm-mfa-enrollment.command.js";
import { CreateEquipmentCommand } from "../../apps/api/dist/modules/equipment/application/commands/create-equipment/create-equipment.command.js";
import { CreateQueueEntryCommand } from "../../apps/api/dist/modules/queue/application/commands/create-queue-entry/create-queue-entry.command.js";
import { UpdateQueueEntryDetailsCommand } from "../../apps/api/dist/modules/queue/application/commands/update-queue-entry-details/update-queue-entry-details.command.js";
import { CreateTenantCommand } from "../../apps/api/dist/modules/tenants/application/commands/create-tenant/create-tenant.command.js";
import { UpdateTenantCommand } from "../../apps/api/dist/modules/tenants/application/commands/update-tenant/update-tenant.command.js";
import { ProposeAgreementCommand } from "../../apps/api/dist/modules/agreements/application/commands/propose-agreement/propose-agreement.command.js";
import { RespondToAgreementCommand } from "../../apps/api/dist/modules/agreements/application/commands/respond-to-agreement/respond-to-agreement.command.js";
import { SetAgreementScopeCommand } from "../../apps/api/dist/modules/agreements/application/commands/set-agreement-scope/set-agreement-scope.command.js";
import { CreateUnitCommand } from "../../apps/api/dist/modules/units/application/commands/create-unit/create-unit.command.js";

interface SeededUser {
  userId: string;
  email: string;
  password: string;
  role: UserRole;
  totpSecret: string;
}

function extractSecret(provisioningUri: string): string {
  const match = provisioningUri.match(/secret=([A-Z0-9]+)/i);
  if (!match) throw new Error(`Could not extract TOTP secret from ${provisioningUri}`);
  return match[1]!;
}

async function registerAndEnroll(
  commandBus: CommandBus,
  tenantId: string,
  email: string,
  password: string,
  role: UserRole,
  firstName: string,
  lastName: string,
  // Every clinic (beyond `tenantId` itself) this account should be linked to -- required,
  // non-empty for CLINIC_ADMIN/LOCAL_SUPERVISOR/NURSING (see requiresClinicAssignment),
  // ignored for every other role. Defaults to just `[tenantId]` for those three roles so
  // most call sites below don't have to repeat it.
  extraClinicIds: string[] = [],
  // Optional, defaults to null (every existing call site's own prior behaviour) -- set for
  // the nursing/operator accounts the day-view feature's own demo data actually displays a
  // registration number for ("Enfª Fernanda Alves · COREN-SP 148209",
  // "Rafael Moura · CRBM 4289").
  professionalRegistration: string | null = null
): Promise<SeededUser> {
  const clinicTenantIds = requiresClinicAssignment(role) ? [tenantId, ...extraClinicIds] : [];
  const { userId, enrollmentToken, provisioningUri } = await commandBus.execute(
    // directActivation: {password} -- this script auto-confirms MFA on the seeded user's
    // own behalf a few lines down, i.e. it's simulating an already-onboarded account, not
    // one that has to redeem an invitation link (see RegisterUserCommand's own docstring).
    new RegisterUserCommand(tenantId, email, role, firstName, lastName, null, professionalRegistration, null, clinicTenantIds, true, { password })
  );
  const totpSecret = extractSecret(provisioningUri);
  const code = new OTPAuth.TOTP({ secret: totpSecret }).generate();
  await commandBus.execute(new ConfirmMfaEnrollmentCommand(enrollmentToken, code));
  return { userId, email, password, role, totpSecret };
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const commandBus = app.get(CommandBus);

  console.log("Seeding tenants...");
  // `CommandBus.execute` for `CreateTenantCommand` resolves to an `EnrichedTenant`
  // (`{tenant, equipmentCount, ...}`), not a bare `Tenant` -- destructured immediately, the
  // same lesson `alphaUnit2`/`betaUnit2` below already learned once for `CreateUnitCommand`.
  const { tenant: alpha } = await commandBus.execute(
    new CreateTenantCommand("Clinica Alpha", TenantType.CLINIC, null, {
      cnpj: "11122233000183",
      institutionalEmail: "contato@clinicaalpha.crop.health",
      phone: "(11) 3456-7890",
      zipCode: "01310-100",
      street: "Avenida Paulista",
      number: "1000",
      complement: null,
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    })
  );
  const { tenant: beta } = await commandBus.execute(
    new CreateTenantCommand("Clinica Beta", TenantType.CLINIC, null, {
      cnpj: "44455566000183",
      institutionalEmail: "contato@clinicabeta.crop.health",
      phone: "(19) 3232-1122",
      zipCode: "13010-001",
      street: "Avenida Francisco Glicério",
      number: "500",
      complement: null,
      district: "Centro",
      city: "Campinas",
      state: "SP",
    })
  );
  // The operating company (see packages/shared/src/roles.ts). Since the role-model inversion
  // this is the ONLY place an OPERATOR/OPERATIONAL_SUPERVISOR/OPERATOR_ADMIN account may
  // live -- a clinic can no longer hold one -- so this tenant is no longer a decorative
  // "staff directory" demo: it is where the people who actually run the exams work.
  //
  // Contracts with both clinics are negotiated further down, once units and equipment exist:
  // an agreement's scope names real units, so it cannot be created before them. A second
  // operating company is seeded too, so the many-to-many shape is actually exercised rather
  // than merely supported -- "Clinica Alpha" ends up contracting two companies with different
  // scope, which the old single `Tenant.operatorTenantId` column could not represent at all.
  const { tenant: central } = await commandBus.execute(new CreateTenantCommand("Operadora Central", TenantType.OPERATOR_PROVIDER));
  const { tenant: teleSul } = await commandBus.execute(new CreateTenantCommand("Teleimagem Sul", TenantType.OPERATOR_PROVIDER));

  console.log("Seeding users (registering + auto-confirming MFA)...");
  const users: SeededUser[] = [];
  users.push(await registerAndEnroll(commandBus, alpha.id, "admin@alpha.crop.health", DEMO_PASSWORD, UserRole.CLINIC_ADMIN, "Ana", "Costa"));
  users.push(await registerAndEnroll(commandBus, alpha.id, "auditor@alpha.crop.health", DEMO_PASSWORD, UserRole.AUDITOR, "Diego", "Rocha"));
  // Beta's own admin -- added alongside the unit-registration feature, whose
  // "Gestor Técnico Local" needs a real, already-registered user belonging to the *target*
  // clinic (see TechnicalManagerValidator): Beta previously had no CLINIC_ADMIN/
  // LOCAL_SUPERVISOR/LOCAL_IT account at all, so "Unidade Centro" below had no eligible
  // candidate to name.
  const betaAdmin = await registerAndEnroll(commandBus, beta.id, "admin@beta.crop.health", DEMO_PASSWORD, UserRole.CLINIC_ADMIN, "Karina", "Duarte");
  users.push(betaAdmin);
  // The clinic-side roles (see packages/shared/src/roles.ts) -- all CLINIC-only, all
  // seeded into Clinica Alpha alongside its existing staff.
  users.push(await registerAndEnroll(commandBus, alpha.id, "enfermagem@alpha.crop.health", DEMO_PASSWORD, UserRole.NURSING, "Fernanda", "Alves", [], "COREN-SP 148209"));
  users.push(
    await registerAndEnroll(
      commandBus,
      alpha.id,
      "supervisorlocal@alpha.crop.health",
      DEMO_PASSWORD,
      UserRole.LOCAL_SUPERVISOR,
      "Gabriel",
      "Pereira"
    )
  );
  // Captured by name, not just pushed -- "Unidade Jardins" below names Helena as its
  // technical manager, demonstrating LOCAL_IT (not just CLINIC_ADMIN) as an eligible role.
  const alphaLocalIt = await registerAndEnroll(commandBus, alpha.id, "ti@alpha.crop.health", DEMO_PASSWORD, UserRole.LOCAL_IT, "Helena", "Barbosa");
  users.push(alphaLocalIt);

  // --- Operadora Central's staff: every operator-side account in the system ---------------
  // These used to be `operator@alpha` / `supervisor@alpha` / `operator@beta`, seeded directly
  // into the clinic tenants they worked in. `ROLE_TENANT_TYPES` now forbids that, so they
  // moved here and were renamed to match: an address claiming "@alpha" on an account that
  // belongs to Operadora Central would misdescribe the very relationship this change is
  // about. They reach Alpha's and Beta's equipment by switching into that clinic's context
  // (`POST /auth/active-clinic`), which an ACTIVE OperatorAgreement authorizes -- see
  // SwitchActiveClinicHandler.
  const centralAdmin = await registerAndEnroll(
    commandBus,
    central.id,
    "admin@central.crop.health",
    DEMO_PASSWORD,
    UserRole.OPERATOR_ADMIN,
    "Igor",
    "Fernandes"
  );
  users.push(centralAdmin);
  users.push(
    await registerAndEnroll(commandBus, central.id, "operator@central.crop.health", DEMO_PASSWORD, UserRole.OPERATOR, "Bruno", "Lima", [], "CRBM-SP 4289")
  );
  users.push(
    await registerAndEnroll(
      commandBus,
      central.id,
      "supervisor@central.crop.health",
      DEMO_PASSWORD,
      UserRole.OPERATIONAL_SUPERVISOR,
      "Carla",
      "Souza"
    )
  );
  // A second operator, to keep the "two operators, different accounts" demo the old
  // operator@alpha/operator@beta pair provided -- now both employed by the same company,
  // which is what the model actually says.
  users.push(
    await registerAndEnroll(commandBus, central.id, "operator2@central.crop.health", DEMO_PASSWORD, UserRole.OPERATOR, "Elisa", "Martins")
  );

  // Teleimagem Sul's staff -- the second operating company. Exists so "a clinic contracts more
  // than one company" is real seeded data rather than a claim: its scope on Clinica Alpha is
  // deliberately different from Operadora Central's (see the agreements section below).
  const sulAdmin = await registerAndEnroll(
    commandBus,
    teleSul.id,
    "admin@telesul.crop.health",
    DEMO_PASSWORD,
    UserRole.OPERATOR_ADMIN,
    "Marcos",
    "Ribeiro"
  );
  users.push(sulAdmin);
  users.push(
    await registerAndEnroll(commandBus, teleSul.id, "operator@telesul.crop.health", DEMO_PASSWORD, UserRole.OPERATOR, "Priscila", "Gomes", [], "CRBM-PR 8821")
  );

  // A Manager linked to more than one clinic ("A Manager is linked to one or more
  // clinics") -- home tenant is Alpha, also a member of Beta. Demonstrates the clinic
  // switcher (`GET /auth/me/clinics` / `POST /auth/active-clinic`).
  users.push(
    await registerAndEnroll(commandBus, alpha.id, "gestor.multi@crop.health", DEMO_PASSWORD, UserRole.CLINIC_ADMIN, "Julia", "Nakamura", [
      beta.id,
    ])
  );

  const alphaAdmin = users[0]!; // admin@alpha.crop.health, registered first, above

  console.log("Assigning each clinic's responsible manager (Gestor Responsável)...");
  // Nullable at creation and assignable only on edit -- a brand-new clinic has zero users to
  // name (see UpdateTenantRequestSchema's own docstring) -- so this has to wait until each
  // clinic's own CLINIC_ADMIN actually exists, the same ordering constraint
  // Unit.technicalManagerId already forced on the units seeded just below.
  await commandBus.execute(new UpdateTenantCommand(alpha.id, alphaAdmin.userId, { responsibleManagerId: alphaAdmin.userId }));
  await commandBus.execute(new UpdateTenantCommand(beta.id, betaAdmin.userId, { responsibleManagerId: betaAdmin.userId }));

  console.log("Seeding units (one extra unit per clinic, beyond the migration's default 'Unidade Principal')...");
  // `CommandBus.execute` for `CreateUnitCommand` resolves to an `EnrichedUnit`
  // (`{unit, equipmentCount, roomCount, technicalManager}`), not a bare `Unit` -- destructured
  // immediately so every reference below (`alphaUnit2.id`, in the equipment section) reads the
  // same as it did before this feature added the denormalized read-model wrapper.
  const { unit: alphaUnit2 } = await commandBus.execute(
    new CreateUnitCommand(
      alpha.id,
      {
        name: "Unidade Jardins",
        establishmentType: EstablishmentType.IMAGING_CENTER,
        // Helena (LOCAL_IT), not the clinic admin -- demonstrates that a technical
        // manager doesn't have to be the CLINIC_ADMIN, just an eligible role (see
        // TECHNICAL_MANAGER_ELIGIBLE_ROLES).
        technicalManagerId: alphaLocalIt.userId,
        declaredModalities: [ExamModality.MRI, ExamModality.CT],
        zipCode: "01415-001",
        street: "Rua Augusta",
        number: "2400",
        complement: null,
        district: "Jardins",
        city: "São Paulo",
        state: "SP",
        cnesCode: "7489202",
        phone: "(11) 3456-7891",
        technicalEmail: "unidade.jardins@clinicaalpha.crop.health",
      },
      alphaAdmin.userId,
      alpha.id,
      UserRole.CLINIC_ADMIN
    )
  );
  // A second Alpha unit, existing specifically so agreement scope has something to *exclude*:
  // Operadora Central's contract covers Unidade Jardins only, so the scanner installed here is
  // reachable by Alpha's own staff and by Teleimagem Sul, and invisible to Central. Without a
  // room outside every contract, "scope narrows access" would be untestable by hand.
  const { unit: alphaUnit3 } = await commandBus.execute(
    new CreateUnitCommand(
      alpha.id,
      {
        name: "Unidade Paulista",
        establishmentType: EstablishmentType.CLINIC,
        technicalManagerId: alphaLocalIt.userId,
        declaredModalities: [ExamModality.XRAY],
        zipCode: "01310-200",
        street: "Avenida Paulista",
        number: "900",
        complement: null,
        district: "Bela Vista",
        city: "São Paulo",
        state: "SP",
        cnesCode: "7489333",
        phone: "(11) 3456-7892",
        technicalEmail: "unidade.paulista@clinicaalpha.crop.health",
      },
      alphaAdmin.userId,
      alpha.id,
      UserRole.CLINIC_ADMIN
    )
  );
  const { unit: betaUnit2 } = await commandBus.execute(
    new CreateUnitCommand(
      beta.id,
      {
        name: "Unidade Centro",
        establishmentType: EstablishmentType.LABORATORY,
        technicalManagerId: betaAdmin.userId,
        declaredModalities: [ExamModality.CT, ExamModality.XRAY],
        zipCode: "13010-001",
        street: "Avenida Francisco Glicério",
        number: "800",
        complement: "Sala 12",
        district: "Centro",
        city: "Campinas",
        state: "SP",
        cnesCode: "7489310",
        phone: "(19) 3232-4455",
        technicalEmail: "unidade.centro@clinicabeta.crop.health",
      },
      betaAdmin.userId,
      beta.id,
      UserRole.CLINIC_ADMIN
    )
  );

  console.log("Seeding equipment (registering MRI-01 against a real or simulated PiKVM)...");
  const pikvmHost = process.env.SEED_PIKVM_HOST ?? "https://192.168.1.50";
  const pikvmUser = process.env.SEED_PIKVM_USER ?? "admin";
  const pikvmPassword = process.env.SEED_PIKVM_PASSWORD ?? "admin";
  // Unset by default: a room camera is opt-in per equipment, and pointing at MediaMTX before
  // anything is publishing to it just gives the demo a permanently-"connecting" PiP box.
  const cctvWhepUrl = process.env.SEED_MEDIAMTX_WHEP_URL ?? null;

  const mri = await commandBus.execute(
    new CreateEquipmentCommand(alpha.id, alphaAdmin.userId, {
      name: "MRI-01",
      unitId: alphaUnit2.id, // explicit, not the auto-default -- demonstrates unit assignment
      modality: ExamModality.MRI,
      brand: "Siemens",
      model: "Magnetom Vida 3.0T",
      serialNumber: "SN-MRI-0001",
      roomLabel: "Sala RM-01 • Pavimento Térreo",
      installedAt: new Date("2025-03-10T00:00:00.000Z"),
      // Recorded the way a real deployment would record what an external PACS team handed
      // over. Nothing in this platform connects to a PACS (see schema.prisma), so these are
      // seeded purely so the equipment form has realistic content to display.
      aeTitle: "RADLINK_MR01",
      dicomIp: "10.240.12.45",
      dicomPort: 104,
      pikvmHost,
      pikvmUser,
      pikvmPassword,
      pikvmTotpSecret: null,
      targetOs: TargetOs.WINDOWS, // production target, per docs/architecture.md
      keymap: "pt-br",
      mouseMode: MouseMode.ABSOLUTE,
      screenWidth: 1920,
      screenHeight: 1080,
      cameraUrl: cctvWhepUrl,
    })
  );

  // Alpha's second scanner, in Unidade Paulista -- deliberately outside Operadora Central's
  // agreement scope. `operator@central` must NOT see this one; `operator@telesul` must.
  const rx = await commandBus.execute(
    new CreateEquipmentCommand(alpha.id, alphaAdmin.userId, {
      name: "RX-02",
      unitId: alphaUnit3.id,
      modality: ExamModality.XRAY,
      brand: "Philips",
      model: "DigitalDiagnost C90",
      serialNumber: "SN-RX-0002",
      roomLabel: "Sala RX-01 • Unidade Paulista",
      installedAt: new Date("2025-08-21T00:00:00.000Z"),
      aeTitle: "RADLINK_RX02",
      dicomIp: "10.240.12.60",
      dicomPort: 104,
      pikvmHost,
      pikvmUser,
      pikvmPassword,
      pikvmTotpSecret: null,
      targetOs: TargetOs.WINDOWS,
      keymap: "pt-br",
      mouseMode: MouseMode.ABSOLUTE,
      screenWidth: 1920,
      screenHeight: 1080,
      cameraUrl: null,
    })
  );

  const ct = await commandBus.execute(
    // Registered by Beta's own CLINIC_ADMIN, not by an operator: provisioning equipment is a
    // clinic-administration act (see EquipmentController's `@Roles`), and the operator who
    // used to be the actor here no longer belongs to this clinic at all.
    new CreateEquipmentCommand(beta.id, betaAdmin.userId, {
      name: "CT-01",
      unitId: betaUnit2.id,
      modality: ExamModality.CT,
      brand: "GE Healthcare",
      model: "Revolution CT 128",
      serialNumber: "SN-CT-0001",
      roomLabel: "Sala TC-02 • 1º Andar",
      installedAt: new Date("2025-06-02T00:00:00.000Z"),
      aeTitle: "RADLINK_CT01",
      dicomIp: "10.240.13.20",
      dicomPort: 104,
      pikvmHost,
      pikvmUser,
      pikvmPassword,
      pikvmTotpSecret: null,
      targetOs: TargetOs.WINDOWS,
      keymap: "en-us",
      mouseMode: MouseMode.ABSOLUTE,
      screenWidth: 1920,
      screenHeight: 1080,
      cameraUrl: null,
    })
  );

  console.log("Negotiating clinic <-> operator agreements...");
  /**
   * Synthesises the token claims a real admin would be acting under. The agreement commands take
   * the acting user's claims (not a bare id) because the "which side am I" decision must come from
   * the token rather than the request body -- see ProposeAgreementHandler. The seed is simulating
   * those admins, so it builds the same shape rather than adding a null-actor bypass to the
   * handlers, which would mean the seed exercised a code path nothing else uses.
   */
  const actorFor = (user: SeededUser, tenantId: string) => ({
    sub: user.userId,
    tenantId,
    role: user.role,
    clientOs: TargetOs.WINDOWS,
    homeTenantId: tenantId,
  });

  // --- Alpha <-> Operadora Central: proposed by the clinic, accepted by the company ----------
  // Scope: Unidade Jardins only. Alpha's MRI-01 lives there, so Central reaches it -- while
  // RX-02 in Unidade Paulista stays out of scope, which is what makes the narrowing visible in
  // the demo instead of only being expressible.
  const alphaCentral = await commandBus.execute(
    new ProposeAgreementCommand(actorFor(alphaAdmin, alpha.id), central.id, [alphaUnit2.id], [])
  );
  await commandBus.execute(new RespondToAgreementCommand(actorFor(centralAdmin, central.id), alphaCentral.id, true));

  // --- Alpha <-> Teleimagem Sul: proposed by the *company*, accepted by the clinic -----------
  // The mirror image of the handshake above, so both directions are real seeded data. Scope is
  // set by Alpha afterwards (an operating company cannot scope itself -- see
  // OperatorAgreement.assertScopeCanBeSetBy), and covers Unidade Paulista: the room Central
  // cannot see. Two companies, same clinic, disjoint scope -- the exact shape the old
  // single-operator column could not express.
  const alphaSul = await commandBus.execute(new ProposeAgreementCommand(actorFor(sulAdmin, teleSul.id), alpha.id, [], []));
  await commandBus.execute(new RespondToAgreementCommand(actorFor(alphaAdmin, alpha.id), alphaSul.id, true));
  await commandBus.execute(new SetAgreementScopeCommand(actorFor(alphaAdmin, alpha.id), alphaSul.id, [alphaUnit3.id], []));

  // --- Beta <-> Operadora Central ------------------------------------------------------------
  // One company serving two clinics, the direction the old column *could* express -- kept so
  // nothing that relied on it is lost.
  const betaCentral = await commandBus.execute(
    new ProposeAgreementCommand(actorFor(betaAdmin, beta.id), central.id, [betaUnit2.id], [])
  );
  await commandBus.execute(new RespondToAgreementCommand(actorFor(centralAdmin, central.id), betaCentral.id, true));

  console.log("Seeding patient queue...");
  // Four patients on Alpha's MRI room, all scheduled for *today* in the clinic's own
  // timezone -- the nursing day-view's "N Pacientes Hoje" count and its `?date=` filter both
  // key off that, so a seed with null/arbitrary-day scheduledAt would leave the feature's
  // headline screen empty on a fresh `make demo`. Four rather than three: enough for a
  // reorder to visibly skip an entry past another (two can only swap), plus one deliberately
  // *unconfirmed-fasting contrast* patient so the "Alerta Jejum" card chip actually renders
  // for a first-time visitor instead of only existing in code.
  const today = todayClinicDayString();
  const at = (time: string) => new Date(clinicTimeToUtcIso(today, time));

  const maria = await commandBus.execute(new CreateQueueEntryCommand(alpha.id, alphaAdmin.userId, mri.id, "Maria", at("08:00")));
  await commandBus.execute(
    new UpdateQueueEntryDetailsCommand(
      alpha.id,
      alphaAdmin.userId,
      maria.id,
      "RM Crânio c/ Contraste",
      true,
      PatientSex.FEMALE,
      65,
      undefined,
      "Jejum de 4h confirmado. Acesso venoso pérvio em MSD (Jelco 20G). Sem contraindicações ao contraste.",
      true,
      4,
      0.9,
      AllergyStatus.NEGATED,
      null,
      85
    )
  );
  const amanda = await commandBus.execute(new CreateQueueEntryCommand(alpha.id, alphaAdmin.userId, mri.id, "Amanda", at("08:30")));
  await commandBus.execute(
    new UpdateQueueEntryDetailsCommand(
      alpha.id,
      alphaAdmin.userId,
      amanda.id,
      "RM Joelho Direito",
      false,
      PatientSex.FEMALE,
      58,
      undefined,
      "Acesso venoso pérvio. Exame sem contraste.",
      true,
      6,
      undefined,
      AllergyStatus.NEGATED,
      null,
      undefined
    )
  );
  // The "Alerta Jejum" case: contrast required, fasting NOT confirmed -- exactly what
  // queueCardChipOf derives its one and only chip from (see its docstring on why this is a
  // display-only workflow flag, never a gate on any action).
  const pedro = await commandBus.execute(new CreateQueueEntryCommand(alpha.id, alphaAdmin.userId, mri.id, "Pedro", at("09:00")));
  await commandBus.execute(
    new UpdateQueueEntryDetailsCommand(
      alpha.id,
      alphaAdmin.userId,
      pedro.id,
      "RM Abdome c/ Contraste",
      true,
      PatientSex.MALE,
      74,
      undefined,
      "Paciente relata ter tomado café da manhã -- jejum NÃO confirmado. Aguardando liberação clínica.",
      false,
      undefined,
      1.1,
      AllergyStatus.PRESENT,
      "Alergia a iodo relatada em exame anterior (reação cutânea leve).",
      undefined
    )
  );
  const joao = await commandBus.execute(new CreateQueueEntryCommand(alpha.id, alphaAdmin.userId, mri.id, "Joao", at("09:30")));
  await commandBus.execute(
    new UpdateQueueEntryDetailsCommand(
      alpha.id,
      alphaAdmin.userId,
      joao.id,
      "RM Coluna Lombar",
      false,
      PatientSex.MALE,
      82,
      undefined,
      null,
      true,
      8,
      undefined,
      AllergyStatus.NEGATED,
      null,
      undefined
    )
  );
  // Beta's single queue entry, created by Beta's own admin -- adding a patient to the queue is
  // clinic-side work (rule: the nursing team owns everything patient-related), so an operator
  // was never the right actor for this even before they stopped belonging to the clinic.
  await commandBus.execute(new CreateQueueEntryCommand(beta.id, betaAdmin.userId, ct.id, "Ana", at("10:00")));

  await app.close();

  console.log("\n=== Seed complete ===\n");
  console.log("Tenants:");
  console.log(`  Clinica Alpha:     ${alpha.id}  (2 operating companies, disjoint scope)`);
  console.log(`  Clinica Beta:      ${beta.id}  (operator: Operadora Central)`);
  console.log(`  Operadora Central: ${central.id}  (agreements: Alpha/Unidade Jardins, Beta/Unidade Centro)`);
  console.log(`  Teleimagem Sul:    ${teleSul.id}  (agreement: Alpha/Unidade Paulista only)`);
  console.log(`  Unidade Jardins (Alpha): ${alphaUnit2.id}`);
  console.log(`  Unidade Centro (Beta):   ${betaUnit2.id}`);
  console.log("\nUsers (password is the same for all, for demo convenience only):");
  for (const user of users) {
    console.log(`  ${user.email} [${user.role}]`);
    console.log(`    password:    ${user.password}`);
    console.log(`    TOTP secret: ${user.totpSecret}  (add to an authenticator app)`);
  }
  console.log(`\nEquipment: MRI-01 (${mri.id}) + RX-02 (${rx.id}) in Clinica Alpha, CT-01 (${ct.id}) in Clinica Beta`);
  console.log("  operator@central sees MRI-01 only (RX-02 is outside its agreement scope); operator@telesul sees RX-02 only.");
  console.log(`PiKVM target: ${pikvmHost} -- override with SEED_PIKVM_HOST/USER/PASSWORD env vars.`);
  console.log(
    cctvWhepUrl
      ? `CCTV: MRI-01's room camera PiP points at ${cctvWhepUrl}\n`
      : "CCTV: not configured -- set SEED_MEDIAMTX_WHEP_URL to enable the room-camera PiP on MRI-01.\n"
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // ioredis (via RedisModule) keeps a TCP socket open that app.close() does not tear down
    // on its own; this is a one-shot CLI script, not long-running app code, so an explicit
    // exit here is the pragmatic fix rather than adding lifecycle-hook plumbing to
    // RedisModule purely to satisfy a script that only ever runs once and quits.
    process.exit();
  });
