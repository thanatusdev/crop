/**
 * pt-BR strings, by namespace. `auth`/`recovery`/`password`/`roles`/`changePassword` are
 * populated so far -- the login, password-recovery, and forced-password-change screens are
 * the first pages moved off hardcoded English (see docs/architecture.md); every other page
 * stays English until it gets its own pass, so mixing in translated-but-unused namespaces
 * here would just be dead weight. `common` exists as the landing spot for anything the next
 * page's pass needs that isn't page-specific (e.g. "Voltar"), so that pass doesn't have to
 * invent a namespace convention from scratch.
 */
const ptBR = {
  // Empty for now -- a landing spot for whatever the next translated page needs that isn't
  // page-specific, so that pass doesn't have to invent a namespace convention from scratch.
  // LoginPage already requests this namespace (`useTranslation(["auth", "common"])`) even
  // though nothing in it is used yet.
  common: {},
  auth: {
    brand: "RadLink",
    tagline: "Acesso ao Sistema Clínico",
    emailLabel: "E-mail",
    passwordLabel: "Senha",
    showPassword: "Mostrar senha",
    hidePassword: "Ocultar senha",
    forgotPassword: "Esqueci a senha",
    submit: "Entrar",
    submitBusy: "Entrando...",
    securityFooter: "Ambiente Seguro • Autenticação em dois fatores via Microsoft Authenticator",
    genericLoginError: "Falha no login",
    mfaIntro: "Digite o código de 6 dígitos do seu aplicativo autenticador.",
    codeLabel: "Código do Microsoft Authenticator (6 dígitos)",
    verify: "Verificar",
    verifyBusy: "Verificando...",
    genericCodeError: "Código inválido",
    enrollIntro: "A autenticação em dois fatores é obrigatória. Escaneie o QR code no seu aplicativo autenticador:",
    enrollUriFallback: "Não conseguiu escanear? Use este código manualmente:",
    enrollCodeLabel: "Digite o código gerado para confirmar",
    confirm: "Confirmar cadastro",
    confirmBusy: "Confirmando...",
    enrolledMessage: "Autenticação de dois fatores cadastrada. Faça login novamente.",
  },

  /**
   * Every UserRole label (see packages/shared/src/enums.ts) -- used by the identity card on
   * the reset/forced-change screens today, and by AdminUsersPage's role picker/table (the
   * only other place a role name is ever rendered to a user).
   */
  roles: {
    PLATFORM_ADMIN: "Administrador da Plataforma",
    CLINIC_ADMIN: "Gestor de Clínica",
    LOCAL_SUPERVISOR: "Supervisor",
    NURSING: "Enfermagem",
    LOCAL_IT: "TI Local",
    OPERATOR_ADMIN: "Administrador da Operadora",
    OPERATIONAL_SUPERVISOR: "Supervisor Operacional",
    OPERATOR: "Operador Biomédico",
    AUDITOR: "Auditor",
  },

  /**
   * Shared between the reset-password screen and the forced-change screen -- both are "set
   * a new password" forms with the same fields, the same live strength meter, and the same
   * policy checklist (see packages/shared/src/password-policy.ts), just reached different
   * ways. One namespace, one SetPasswordForm component, one place to keep the copy and the
   * actual rules in sync.
   */
  password: {
    newPasswordLabel: "Nova Senha",
    newPasswordPlaceholder: "Insira nova senha segura",
    confirmPasswordLabel: "Confirme a nova senha",
    confirmPasswordPlaceholder: "Confirme sua senha",
    mismatch: "As senhas não coincidem.",
    showPassword: "Mostrar senha",
    hidePassword: "Ocultar senha",

    strengthAwaiting: "Aguardando entrada",
    strengthWeak: "Senha fraca",
    strengthMedium: "Senha média",
    strengthStrong: "Senha forte",

    policyBadgeTitle: "Diretrizes de segurança clínica (CFM/HIPAA)",
    policyBadgeLevel: "Padrão Alta Proteção",
    ruleMinLength: "Mínimo de 8 caracteres (10+ rec.)",
    ruleMixedCase: "Maiúscula e minúscula",
    ruleDigit: "Pelo menos 1 número",
    ruleSymbol: 'Símbolo especial (@, #, $, %)',
    ruleNoPersonalInfo: 'Não deve conter seu primeiro nome, sobrenome ou "radlink"',
    ruleSatisfied: "Regra atendida",
    ruleNotSatisfied: "Regra não atendida",

    save: "Salvar Nova Senha",
    saveBusy: "Salvando...",
    genericError: "Não foi possível salvar a nova senha. Tente novamente.",
    policyError: "A senha não atende aos critérios de segurança exigidos.",
    reusedError: "Esta senha já foi utilizada recentemente nesta conta. Escolha outra.",
    successFooter: "Sua credencial será atualizada imediatamente em todos os consoles e exigirá validação MFA.",
  },

  recovery: {
    tagline: "Acesso ao Sistema Clínico",
    tabRequest: "Solicitar Token",
    tabReset: "Nova Senha",

    requestTitle: "Esqueceu sua senha?",
    requestBody: "Informe seu e-mail cadastrado e enviaremos um link de acesso para redefinir sua senha.",
    emailLabel: "E-mail",
    send: "Enviar",
    sendBusy: "Enviando...",
    genericRequestError: "Não foi possível enviar o link. Tente novamente.",

    modalBadge: "AVISO • CONFIRMAÇÃO DE ENVIO",
    modalTitle: "Link de Acesso Enviado",
    modalBody: "Um link de acesso foi enviado para o e-mail:",
    modalInfo: "Verifique sua caixa de entrada e a pasta de spam. O link é de uso único e expira em {{minutes}} minutos.",
    modalOk: "OK",

    stepRequest: "Solicitação de Token",
    stepReset: "Nova Senha Clínica",
    resetTitle: "Cadastrar Nova Senha",
    resetSubtitle: "Crie uma nova credencial de acesso institucional para sua estação de teleoperação RadLink.",
    professionalRegistrationLabel: "Registro profissional",
    loadingToken: "Verificando link...",

    pasteTokenIntro: "Recebeu um token por e-mail mas o link não abriu corretamente? Cole o token abaixo para continuar.",
    tokenLabel: "Token de acesso",
    continueLabel: "Continuar",

    expiryLabel: "Expiração do token",
    invalidTokenTitle: "Link inválido ou expirado",
    invalidTokenBody: "Este link de redefinição não é mais válido -- ele pode ter expirado ou já ter sido utilizado.",
    requestNewLink: "Solicitar novo link",
    expiredMessage: "Este link expirou. Solicite um novo para continuar.",
    supportNote: "Dúvidas na redefinição?",
    supportContact: "Suporte TI NOC",

    resetSuccess: "Senha redefinida com sucesso. Faça login com sua nova senha.",
    backToLogin: "Voltar para o login",
  },

  changePassword: {
    tagline: "Acesso ao Sistema Clínico",
    title: "Atualize sua senha",
    reasonMustChange: "Por segurança, defina uma nova senha para continuar. Esta credencial foi definida por um administrador e é de uso único.",
    reasonExpired: "Sua senha expirou e precisa ser atualizada para continuar.",
    expiryLabel: "Esta sessão de troca expira em",
    expiredMessage: "O tempo para definir a nova senha esgotou. Faça login novamente.",
    backToLogin: "Voltar para o login",
  },

  /**
   * The invitation-activation screen -- reached from the "Enviar Convite Seguro" link
   * (see AdminUsersPage / SendInvitationHandler). Same shape as `recovery`'s reset tab:
   * validate the token read-only first (never burns it), then let the new user choose
   * their own first password.
   */
  activation: {
    tagline: "Acesso ao Sistema Clínico",
    loadingToken: "Verificando convite...",
    invalidTokenBody: "Este convite não é mais válido -- ele pode ter expirado ou já ter sido utilizado. Contate o administrador da sua clínica para receber um novo.",
    expiredMessage: "Este convite expirou. Contate o administrador da sua clínica para receber um novo.",
    noTokenBody: "Nenhum convite foi encontrado nesta página. Verifique o link recebido por e-mail.",
    title: "Ative sua conta",
    subtitle: "Escolha sua senha de acesso para concluir a ativação da sua conta RadLink.",
    expiryLabel: "Expiração do convite",
    activationSuccess: "Conta ativada com sucesso. Faça login com sua nova senha.",
    backToLogin: "Voltar para o login",
  },

  /**
   * `ConsoleShell`'s own chrome (sidebar nav, topbar) -- shared by Dashboard, Gestores &
   * Usuários, Unidades, Equipamentos, and the superadmin Tenants page. See that
   * component's own docstring for the three mock elements deliberately NOT reproduced
   * (fabricated DICOM/PACS pill, HIPAA/CFM-SBIS compliance-claim footer, settings gear).
   */
  shell: {
    hubLabel: "Hub Operacional",
    navLabel: "Navegação principal",
    navDashboard: "Painel",
    navUsers: "Gestores & Usuários",
    navClinics: "Clínicas",
    navUnits: "Unidades",
    navEquipment: "Equipamentos",
    navNursing: "Enfermagem",
    navAgreements: "Contratos",
    healthPill: "Equipamentos: {{online}}/{{total}} online",
    healthPillLoading: "Verificando equipamentos...",
    signOut: "Sair",
    footerNote: "Ambiente de demonstração",
  },

  /**
   * AdminUsersPage's full translation pass. Originally kept its own dark theme on purpose
   * (see docs/architecture.md); now wrapped in the light-themed `ConsoleShell` alongside
   * the other admin pages -- that reversal, and why, is documented on `ConsoleShell`
   * itself. `DashboardPage`'s own "Manage users" button that links here is deliberately
   * NOT translated in this same pass -- see this namespace's own note in architecture.md
   * about that seam.
   */
  adminUsers: {
    topbarTitle: "Gerenciar usuários",
    backToDashboard: "Voltar ao painel",
    heading: "Usuários",

    createTitle: "Criar usuário",
    inviteNote: "Um link de ativação seguro será enviado para este e-mail (válido por 24 horas). A pessoa escolherá sua própria senha e configurará a autenticação em dois fatores no primeiro acesso.",
    emailLabel: "E-mail corporativo",
    firstNameLabel: "Nome",
    lastNameLabel: "Sobrenome",
    professionalRegistrationLabel: "Registro profissional (opcional)",
    roleLabel: "Perfil de acesso",
    tenantLabel: "Clínica/Empresa",
    tenantPlaceholder: "Selecione...",
    tenantDeactivatedSuffix: " (desativada)",
    clinicsLabel: "Clínicas vinculadas",
    clinicsHint: "Selecione uma ou mais clínicas -- a primeira selecionada será a clínica padrão desta pessoa.",
    clinicsEmpty: "Nenhuma clínica disponível.",
    statusLabel: "Status",
    statusActiveToggle: "Ativo -- permite login imediato após a ativação do convite",
    create: "Enviar convite",
    creating: "Enviando...",
    genericCreateError: "Não foi possível criar o usuário.",

    createdBannerTitle: "Convite enviado.",
    createdBannerBody: "Um link de ativação foi enviado para o e-mail abaixo.",
    createdEmailField: "e-mail",
    createdRoleField: "perfil",

    tableCaption: "Usuários da sua organização",
    colEmail: "E-mail",
    colName: "Nome",
    colRole: "Perfil",
    colMfa: "2FA",
    colActivation: "Convite",
    colStatus: "Status",
    colActions: "Ações",
    mfaEnrolled: "Cadastrado",
    mfaPending: "Pendente",
    activationPending: "Aguardando ativação",
    activationDone: "Ativado",
    statusLocked: "Bloqueado",
    statusActive: "Ativo",
    mustChangeBadge: "Aguardando 1ª troca",

    lock: "Bloquear",
    unlock: "Desbloquear",
    resetPassword: "Redefinir senha",
    resendInvite: "Reenviar convite",
    newPasswordFor: "Nova senha para",
    confirm: "Confirmar",
    genericActionError: "Não foi possível atualizar este usuário.",
    genericResetError: "Não foi possível redefinir a senha deste usuário.",
    genericResendError: "Não foi possível reenviar o convite.",

    loading: "Carregando...",
    loadError: "Não foi possível carregar os usuários.",
    retry: "Tentar novamente",
    empty: "Nenhum usuário na sua organização ainda.",
  },

  /**
   * The read-only capability list shown under the role dropdown in AdminUsersPage's create
   * form (see `RolePermissionSummary.tsx` / `ROLE_CAPABILITIES` in `packages/shared`).
   * Deliberately not the mock's literal three checkboxes ("Relatórios de Produtividade",
   * "Supervisão de Intercorrências") -- neither corresponds to a real feature anywhere in
   * this app. Every key below maps to an `@Roles` decorator that actually exists.
   */
  permissions: {
    title: "O que este perfil poderá fazer",
    empty: "Nenhuma capacidade adicional.",
    user_management_clinic: "Gestão de usuários da clínica (todos os perfis locais)",
    user_management_clinic_staff: "Cadastro de Enfermagem e TI local",
    user_management_operator: "Gestão de usuários (Supervisor/Operador)",
    equipment_management: "Gestão de equipamentos e unidades",
    queue_management: "Gestão de filas e exames",
    session_supervision: "Supervisão de sessões (takeover)",
    session_operation: "Operação de sessões",
    audit_access: "Acesso à auditoria",
    audit_access_readonly: "Acesso à auditoria (somente leitura)",
    tenant_management: "Gestão de tenants e clínicas",
    all_above: "Todas as capacidades acima",
  },

  /**
   * Unit registry -- the listing screen (`AdminUnitsPage`) and the dedicated
   * create/edit/view form (`UnitFormPage`). A clinic's own sub-sites ("like a hospital" --
   * see schema.prisma's `Unit` model).
   *
   * Built from the RadLink unit-registration mock, continuing the same policy
   * `ConsoleShell`/the equipment registry pass already set: anything the mock asserted that
   * this platform does not actually do is not reproduced. Specifically absent, and
   * deliberately, for the same reasons the equipment registry's own namespace documents:
   *
   * - **"Sincronizar PACS" button** and the **"REDES VINCULADAS" / "100% Homologadas" /
   *   "Média un./clínica"** card. No PACS integration exists, and the metric itself isn't
   *   derivable from anything real -- replaced with a genuine "Equipamentos Vinculados"
   *   total, computed from the same units already on screen.
   * - **"Matrizes: 06 • Filiais: 12"**. Nothing in this feature's data model distinguishes a
   *   headquarters from a branch -- the form that would set it doesn't exist -- so the split
   *   is dropped; the total itself is kept.
   * - **"TC & RM GSDF"** under the rooms card. Fabricated jargon describing a display
   *   calibration standard this platform has no knowledge of a room's hardware satisfying.
   * - **"✓ CEP validado na base dos correios"**. CEP format is validated (8 digits); nothing
   *   checks it against Correios or any postal database, so the field's own hint says so.
   * - **"CREDENCIAÇÃO CFM OK"** next to the technical manager. Nothing verifies a CFM/CRM
   *   registration against any registry -- the person's own `professionalRegistration` is
   *   shown as recorded, with no verification claim attached.
   * - **"PROTOCOLO ADM UN-2024"**, **"Validação Automática"**, the **LGPD/CFM/SBIS**
   *   footer, and the invented `ID: UNI-001` codes. Same reasoning as the equipment
   *   registry's own namespace: unbacked compliance/protocol furniture, and an id format
   *   nothing in this system generates -- the table's unit sub-line shows the real CNES
   *   code or establishment type instead.
   */
  adminUnits: {
    heading: "Gestão de Unidades Operacionais",
    subheading: "Gerencie as unidades físicas, seus vínculos institucionais e salas de exame.",
    breadcrumbHome: "Início",
    breadcrumbList: "Unidades",
    newUnit: "+ Nova Unidade",

    statsTotalLabel: "Total de Unidades",
    statsTotalNew: "+{{count}} este mês",
    statsActiveLabel: "Unidades Ativas",
    statsActivePct: "{{pct}}% ativas",
    statsActiveNote: "{{count}} inativas",
    statsRoomsLabel: "Salas / Gantry",
    statsRoomsNote: "Identificadas a partir dos equipamentos vinculados",
    statsEquipmentLabel: "Equipamentos Vinculados",
    statsEquipmentNote: "Distribuídos entre as unidades listadas",

    searchLabel: "Buscar unidade",
    searchPlaceholder: "Buscar por nome, CNES, cidade ou clínica",
    filterStatusLabel: "Status",
    filterStatusAll: "Todos os status",
    filterClinicLabel: "Clínica",
    filterClinicAll: "Todas as Clínicas",
    filterTypeLabel: "Tipo",
    filterTypeAll: "Todos os Tipos",
    filterClear: "Limpar",
    filterResultCount: "{{filtered}} de {{total}} unidades",
    export: "Exportar CSV",

    tableCaption: "Unidades cadastradas",
    colName: "Nome da Unidade",
    colClinic: "Clínica",
    colType: "Tipo",
    colAddress: "Endereço / Cidade",
    colStatus: "Status",
    colActions: "Ações",
    notRecorded: "Não informado",

    statusActive: "Ativo",
    statusInactive: "Inativo",

    actionView: "Ver detalhes",
    actionEdit: "Editar",
    actionDeactivate: "Desativar",
    actionReactivate: "Reativar",

    confirmDeactivateTitle: "Desativar unidade",
    confirmDeactivateBodyWithEquipment:
      "{{name}} deixará de aceitar novas sessões de teleoperação em seus {{count}} equipamentos vinculados. Nenhum equipamento é desativado individualmente, e uma sessão em andamento não é encerrada. O cadastro é preservado e pode ser reativado depois.",
    confirmDeactivateBodyNoEquipment: "{{name}} deixará de aceitar novas sessões de teleoperação. O cadastro é preservado e pode ser reativado depois.",
    confirmDeactivateConfirm: "Desativar",
    confirmCancel: "Cancelar",

    pageSizeLabel: "Linhas por página",
    paginationSummary: "Mostrando {{from}} a {{to}} de {{total}} unidades",
    paginationPrev: "Página anterior",
    paginationNext: "Próxima página",
    paginationPage: "Página {{page}}",

    loading: "Carregando...",
    loadError: "Não foi possível carregar as unidades.",
    retry: "Tentar novamente",
    empty: "Nenhuma unidade cadastrada ainda.",
    emptyFiltered: "Nenhuma unidade corresponde aos filtros aplicados.",
    genericActionError: "Não foi possível concluir esta ação.",
  },

  /** The dedicated create/edit/read-only form for one unit. */
  unitForm: {
    breadcrumbHome: "Início",
    breadcrumbList: "Unidades",
    breadcrumbNew: "Cadastrar Unidade",
    breadcrumbEdit: "Editar Unidade",
    breadcrumbView: "Detalhes da Unidade",

    createTitle: "Cadastrar Nova Unidade",
    createSubtitle: "Preencha os dados da unidade física, selecione a clínica mantenedora, o tipo de estabelecimento e o status operacional.",
    editTitle: "Editar Unidade",
    editSubtitle: "Atualize os dados institucionais, o endereço e a modalidade desta unidade.",
    viewTitle: "Detalhes da Unidade",
    viewSubtitle: "Visualização somente leitura do cadastro desta unidade.",
    requiredLegend: "Campos com * são obrigatórios",

    sectionInstitutional: "Dados da Unidade & Vínculo Institucional",
    sectionAddress: "Endereço Físico & Dados Regulatórios",
    sectionModality: "Modalidades & Responsável Operacional",

    nameLabel: "Nome da unidade",
    nameHint: "Nome identificador interno, exibido para os telelaudistas.",
    namePlaceholder: "Unidade Jardins",
    clinicLabel: "Clínica mantenedora",
    clinicHint: "Instituição jurídica à qual esta unidade pertence. Não pode ser alterada após o cadastro.",
    clinicPlaceholder: "Selecione...",
    establishmentTypeLabel: "Tipo de estabelecimento",
    establishmentTypeHint: "Classificação da unidade perante a infraestrutura de saúde.",
    establishmentTypePlaceholder: "Selecione...",
    establishmentLaboratory: "Laboratório",
    establishmentImagingCenter: "Centro de Imagem",
    establishmentHospital: "Hospital",
    establishmentClinic: "Clínica",
    establishmentUrgentCare: "Pronto Atendimento",
    establishmentMobileUnit: "Unidade Móvel",

    operationalLabel: "Status operacional",
    operationalHint: "Define se a unidade aceita novas sessões de teleoperação em seus equipamentos. Um equipamento retirado de serviço individualmente permanece assim mesmo que a unidade seja reativada.",
    operationalOn: "Unidade ativa / operacional",
    operationalOff: "Unidade desativada",

    cnesLabel: "Código CNES",
    cnesHint: "Registro no Cadastro Nacional de Estabelecimentos de Saúde (opcional).",
    cnesPlaceholder: "7489201",
    phoneLabel: "Telefone / ramal da unidade",
    phonePlaceholder: "(11) 3456-7890",
    technicalEmailLabel: "E-mail da recepção técnica",
    technicalEmailPlaceholder: "unidade01@clinica1.com.br",

    zipCodeLabel: "CEP",
    zipCodeHint: "Apenas o formato é validado (8 dígitos) -- não há consulta à base dos Correios.",
    zipCodePlaceholder: "01310-100",
    streetLabel: "Logradouro / Rua",
    streetPlaceholder: "Avenida Paulista",
    numberLabel: "Número",
    numberPlaceholder: "1234",
    complementLabel: "Complemento (opcional)",
    complementPlaceholder: "Bloco A - Térreo",
    districtLabel: "Bairro",
    districtPlaceholder: "Bela Vista",
    cityLabel: "Cidade",
    cityPlaceholder: "São Paulo",
    stateLabel: "UF",
    statePlaceholder: "Selecione...",

    modalityLabel: "Modalidades instaladas nesta unidade",
    modalityRequiredError: "Selecione ao menos uma modalidade.",
    modalityMri: "Ressonância Magnética (RM)",
    modalityMriHint: "1.5T / 3.0T Alto Campo",
    modalityCt: "Tomografia (TC)",
    modalityCtHint: "64 / 128 Slices Scanner",
    modalityUltrasound: "Ultrassom (USG)",
    modalityUltrasoundHint: "Doppler Color",
    modalityXray: "Raio-X Digital (RX)",
    modalityXrayHint: "Estação Direta",

    technicalManagerLabel: "Gestor técnico local",
    technicalManagerHint: "Responsável operacional pela unidade -- deve ser um usuário já cadastrado nesta clínica.",
    technicalManagerPlaceholder: "Selecione...",
    technicalManagerUnassign: "(nenhum -- deixar sem gestor técnico)",
    technicalManagerNone: "Nenhum gestor técnico atribuído.",
    technicalManagerLoadError: "Não foi possível carregar os gestores técnicos elegíveis desta clínica.",
    professionalRegistration: "Registro profissional: {{value}}",

    save: "Salvar Unidade",
    saving: "Salvando...",
    cancel: "Cancelar",
    backToList: "Voltar para unidades",
    editThis: "Editar unidade",
    genericSaveError: "Não foi possível salvar a unidade.",
    loadError: "Não foi possível carregar esta unidade.",
    loading: "Carregando...",
    validationSummary: "Corrija os campos destacados para continuar.",
  },

  /**
   * Equipment registry -- the listing screen (`AdminEquipmentPage`) and the dedicated
   * create/edit/view form (`EquipmentFormPage`).
   *
   * Built from the RadLink equipment mock, continuing the same policy `ConsoleShell` set:
   * anything the mock asserted that this platform does not actually do is not reproduced.
   * Specifically absent, and deliberately:
   *
   * - **"Sincronizar PACS" button.** There is no PACS integration to synchronise with (see
   *   docs/architecture.md). A button that no-ops or merely refetches the list while claiming
   *   to sync a PACS is worse than no button.
   * - **"Gateway Local: 10.240.12.0/24 (VPN IPSec RadLink Ativa)" / "STATUS: PRONTO PARA
   *   PAREAMENTO" banner.** Asserts a live tunnel this screen has not checked and cannot check.
   * - **"ISO 13485", "DICOM PART 14", "PROTOCOLO ADM EQ-2024", "Validação Automática",
   *   "DISPOSITIVO MÉDICO" badges, and the "conformidade com LGPD e normas CFM / SBIS"
   *   footer.** Regulatory-conformance claims nothing in this codebase has been built or
   *   audited to satisfy -- the same reason ConsoleShell dropped the mock's "HIPAA" footer.
   * - **"Calibração periódica ANVISA" / "Aguardando link de rede DICOM" stat-card
   *   subtitles.** There is no calibration schedule and no DICOM link state in the data
   *   model; those cards carry a real count and a real explanation instead.
   *
   * The AE Title / DICOM IP / port *fields* are kept, because storing what an external PACS
   * team told you is a real thing an operator wants to record -- `dicomNote` says plainly
   * that the platform itself does not use them, so the form does not imply otherwise.
   */
  adminEquipment: {
    heading: "Gestão de Equipamentos & Scanners",
    subheading: "Gerencie scanners radiológicos, salas vinculadas, fabricantes e status operacional.",
    breadcrumbHome: "Início",
    breadcrumbList: "Equipamentos",
    newEquipment: "+ Novo Equipamento",

    statsTotalLabel: "Total de Equipamentos",
    statsTotalByModality: "RM: {{mri}} · TC: {{ct}} · USG: {{ultrasound}} · RX: {{xray}}",
    statsTotalUnclassified: "{{count}} sem modalidade registrada",
    statsActiveLabel: "Equipamentos Ativos",
    statsActivePct: "{{pct}}% operando",
    statsMaintenanceLabel: "Em Manutenção",
    statsMaintenanceNote: "Manutenção declarada manualmente",
    statsInactiveLabel: "Inativos",
    statsInactiveNote: "Fora de operação",
    // Degraded is the fourth real status the mock's three buckets had no place for: the
    // console answers but its HID is not ready. Surfaced here rather than quietly folded into
    // "ativos" (it is not operating normally) or "inativos" (it is not out of service).
    statsDegradedNote: "{{count}} com console degradado",
    statsOfflineNote: "{{count}} sem conexão com o console",

    searchLabel: "Buscar equipamento",
    searchPlaceholder: "Buscar por nome, marca, modelo ou nº de série",
    filterStatusLabel: "Status",
    filterStatusAll: "Todos os status",
    filterModalityLabel: "Modalidade",
    filterModalityAll: "Todas as modalidades",
    filterUnitLabel: "Unidade",
    filterUnitAll: "Todas as unidades",
    filterClear: "Limpar",
    filterResultCount: "{{filtered}} de {{total}} equipamentos",
    export: "Exportar CSV",
    exportEmpty: "Nada para exportar com os filtros atuais.",

    tableCaption: "Equipamentos cadastrados na sua organização",
    colName: "Nome do Equipamento",
    colBrand: "Marca / Fabricante",
    colModel: "Modelo",
    colSerial: "Nº de Série",
    colUnitRoom: "Unidade / Sala",
    colStatus: "Status",
    colActions: "Ações",
    unassignedUnit: "Sem unidade",
    noRoom: "Sala não informada",
    notRecorded: "Não informado",

    statusActive: "Ativo",
    statusMaintenance: "Manutenção",
    statusInactive: "Inativo",
    statusOffline: "Offline",
    statusDegraded: "Degradado",
    // Shown on a deactivated device whose last observed health is now frozen -- see
    // EquipmentSchema's note on why `deactivated` has to be read before `status`.
    statusInactiveFrozenHint: "Fora de operação (última leitura: {{status}})",

    actionEdit: "Editar",
    actionView: "Ver detalhes",
    actionDeactivate: "Desativar",
    actionReactivate: "Reativar",
    actionEnterMaintenance: "Colocar em manutenção",
    actionClearMaintenance: "Encerrar manutenção",

    confirmDeactivateTitle: "Desativar equipamento",
    // States plainly what deactivation does and does not do, because the handler deliberately
    // does not abort a session already in progress on the device.
    confirmDeactivateBody:
      "{{name}} deixará de aceitar novas sessões de teleoperação e sairá do monitoramento de status. Uma sessão em andamento não é encerrada. O cadastro é preservado e pode ser reativado depois.",
    confirmDeactivateConfirm: "Desativar",
    confirmCancel: "Cancelar",

    pageSizeLabel: "Linhas por página",
    paginationSummary: "Mostrando {{from}} a {{to}} de {{total}} equipamentos",
    paginationPrev: "Página anterior",
    paginationNext: "Próxima página",
    paginationPage: "Página {{page}}",

    loading: "Carregando...",
    loadError: "Não foi possível carregar os equipamentos.",
    retry: "Tentar novamente",
    empty: "Nenhum equipamento cadastrado ainda.",
    emptyFiltered: "Nenhum equipamento corresponde aos filtros aplicados.",
    genericActionError: "Não foi possível concluir esta ação.",
  },

  /** The dedicated create/edit/read-only form for one piece of equipment. */
  equipmentForm: {
    breadcrumbHome: "Início",
    breadcrumbList: "Equipamentos",
    breadcrumbNew: "Cadastrar Equipamento",
    breadcrumbEdit: "Editar Equipamento",
    breadcrumbView: "Detalhes do Equipamento",

    createTitle: "Cadastrar Equipamento",
    createSubtitle: "Cadastre scanners de imagem, associe a uma unidade operacional e registre os dados de identificação do dispositivo.",
    editTitle: "Editar Equipamento",
    editSubtitle: "Atualize os dados de identificação, o vínculo operacional e a configuração de teleoperação deste scanner.",
    viewTitle: "Detalhes do Equipamento",
    viewSubtitle: "Visualização somente leitura do cadastro deste scanner.",
    requiredLegend: "Campos com * são obrigatórios",

    sectionIdentification: "Dados de Identificação do Equipamento",
    sectionLink: "Vínculo Operacional & Instalação",
    sectionModality: "Modalidade & Identificação DICOM",
    sectionTeleoperation: "Conexão de Teleoperação (PiKVM)",

    nameLabel: "Nome do equipamento",
    nameHint: "Nome identificador interno, exibido na central de laudos e no painel.",
    namePlaceholder: "Ressonância 01",
    brandLabel: "Marca / fabricante",
    brandPlaceholder: "Siemens",
    modelLabel: "Modelo",
    modelPlaceholder: "Magnetom Vida 3.0T",
    serialLabel: "Número de série",
    serialHint: "Número do fabricante, usado para rastrear calibração e inventário.",
    serialPlaceholder: "123456789",
    roomLabel: "Identificador da sala / gantry",
    roomHint: "Localização física do equipamento, como escrita pela própria unidade.",
    roomPlaceholder: "Sala RM-01 • Pavimento Térreo",

    unitLabel: "Unidade vinculada",
    unitHint: "Unidade onde o equipamento está fisicamente instalado.",
    unitAutomatic: "(automático — unidade padrão da clínica)",
    unitManageLink: "Gerenciar unidades",
    installedAtLabel: "Data de instalação / homologação",
    installedAtHint: "Data em que o equipamento foi liberado para uso clínico — não a data deste cadastro.",

    operationalLabel: "Status operacional",
    // Deliberately describes only what deactivation actually controls. The mock's original
    // wording ("pode receber agendamentos e transferir imagens no PACS") describes a
    // scheduling system and a PACS transfer, neither of which exists here.
    operationalHint:
      "Define se o equipamento aceita novas sessões de teleoperação e se seu status é monitorado. O status de conexão (online, offline, degradado) é detectado automaticamente e não é definido aqui.",
    operationalOn: "Equipamento ativo / operacional",
    operationalOff: "Equipamento desativado",

    modalityLabel: "Modalidade radiológica instalada",
    modalityMri: "Ressonância Magnética (RM)",
    modalityMriHint: "Exames por ressonância magnética",
    modalityCt: "Tomografia Computadorizada (TC)",
    modalityCtHint: "Exames por tomografia",
    modalityUltrasound: "Ultrassom (USG)",
    modalityUltrasoundHint: "Exames por ultrassonografia",
    modalityXray: "Raio-X Digital (RX)",
    modalityXrayHint: "Exames radiográficos digitais",

    // The one place the form states outright that these three fields are recorded, not used.
    dicomNote:
      "Campos opcionais, armazenados apenas como registro dos dados fornecidos pela equipe do PACS. Esta plataforma não estabelece conexão DICOM e não envia nem recebe imagens.",
    aeTitleLabel: "AE Title (Application Entity)",
    aeTitleHint: "Até 16 caracteres: letras maiúsculas, números, _ ou -.",
    aeTitlePlaceholder: "RADLINK_MR01",
    dicomIpLabel: "Endereço IP ou host",
    dicomIpPlaceholder: "10.240.12.45",
    dicomPortLabel: "Porta DICOM",
    dicomPortPlaceholder: "104",

    // This section has no counterpart in the mock, which showed only the DICOM fields. It is
    // required all the same: these are the credentials the platform actually uses to drive the
    // scanner's console, and without them a registered device cannot be operated at all.
    teleoperationNote:
      "Dados usados pela plataforma para controlar remotamente o console do equipamento via PiKVM. Obrigatórios para que o equipamento possa ser teleoperado.",
    pikvmHostLabel: "Endereço do PiKVM",
    pikvmHostPlaceholder: "https://10.240.12.50",
    pikvmUserLabel: "Usuário do PiKVM",
    pikvmPasswordLabel: "Senha do PiKVM",
    pikvmPasswordEditHint: "Deixe em branco para manter a senha atual.",
    targetOsLabel: "Sistema operacional do console",
    keymapLabel: "Layout de teclado",
    screenWidthLabel: "Largura da tela (px)",
    screenHeightLabel: "Altura da tela (px)",
    cameraUrlLabel: "URL da câmera da sala (opcional)",
    cameraUrlHint: "Feed WebRTC/WHEP exibido como picture-in-picture durante a sessão.",

    save: "Salvar equipamento",
    saving: "Salvando...",
    cancel: "Cancelar",
    backToList: "Voltar para equipamentos",
    editThis: "Editar equipamento",
    createdBanner: "Equipamento cadastrado.",
    updatedBanner: "Alterações salvas.",
    genericSaveError: "Não foi possível salvar o equipamento.",
    loadError: "Não foi possível carregar este equipamento.",
    loading: "Carregando...",
    validationSummary: "Corrija os campos destacados para continuar.",
  },

  /**
   * Clinic registry -- the listing screen (`AdminClinicsPage`) and the dedicated
   * create/edit/view form (`ClinicFormPage`). Reshaped from the old, fully-English, single-
   * field `SuperadminTenantsPage` (see docs/architecture.md for that history) rather than
   * built as a second screen -- `GET /tenants` keeps returning every tenant type unchanged,
   * this page just filters to CLINIC and shapes itself around the clinic-registration mock.
   *
   * Continuing the same policy the equipment/unit registry passes already set: anything the
   * mock asserted that this platform does not actually do is not reproduced. Specifically
   * absent, and deliberately:
   *
   * - **Section 03 "Equipamentos & Modalidades de Imagem"** (modality, room/gantry id,
   *   scanner make+model, AE Title/DICOM port) -- every one of those is already a field on
   *   `Equipment`, registered on its own screen; the listing's own "Modalidades" column and
   *   "Equipamentos Vinculados" card are derived from real equipment instead of re-asking
   *   for the same data a third time (`Unit.declaredModalities` already being the second).
   * - **"Nível de Acesso Concedido"**. This codebase's access model is `UserRole` only --
   *   see docs/architecture.md on why per-user permission grants were deliberately not
   *   built. A dropdown that would silently grant nothing is worse than no dropdown.
   * - **The "credenciamento técnico / certificado digital" checkbox, "CFM / LGPD OK"
   *   badge, "Sincronizar PACS" button, "PROTOCOLO ADM CL-2024" tag, "Validação
   *   Automática" badge, the "GRID DICOM CLÍNICO" topbar pill, "Rede Local ... VPN IPSec
   *   Ativa" banner, "INTEGRAÇÃO DICOM PART 14" pill, and "CEP validado via base de
   *   correios"**. Same reasoning as every prior pass: no PACS/DICOM integration, no CFM
   *   registry check, no postal-database lookup exists anywhere in this codebase.
   * - **"3 Em Configuração" / "Target > 90%" / "SLA Resp: 8m" / "100% Cobertura" as
   *   literals, and the "Suspenso Manutenção" / "Aguardando Homologação" row states**. Only
   *   `deactivatedAt` is a real column -- Ativo/Inativo are the only two states this
   *   feature's data model can honestly report.
   * - **Invented `ID: CLI-001` codes, the LGPD/CFM-SBIS footer, "COMUNICAÇÃO TÁTICA"
   *   (Intercom/Telemetria), "DICOM PACS 14 v3.8.4 HIPAA"**, and the nav items with nothing
   *   behind them (Cockpit, Exames, Enfermagem, Supervisão, Teleoperação CT/RM).
   *
   * What the mock's own CNPJ data *did* reveal as real: matriz/filial and "branches of this
   * clinic" are derived straight from the CNPJ (see `packages/shared/src/cnpj.ts`) -- no
   * new relationship column, and the sub-line under a clinic's name shows that real
   * derivation instead of an invented id.
   */
  adminClinics: {
    heading: "Gestão de Clínicas Cadastradas",
    subheading: "Gerencie as clínicas credenciadas, seus vínculos institucionais e gestores responsáveis.",
    breadcrumbHome: "Início",
    breadcrumbList: "Clínicas",
    newClinic: "+ Nova Clínica",

    statsTotalLabel: "Total de Clínicas",
    statsTotalNew: "+{{count}} este mês",
    statsTotalBranches: "{{matriz}} matrizes · {{filial}} filiais",
    statsActiveLabel: "Clínicas Ativas",
    statsActivePct: "{{pct}}% ativas",
    statsActiveNote: "{{count}} inativas",
    statsEquipmentLabel: "Equipamentos Vinculados",
    statsEquipmentNote: "Distribuídos entre as clínicas listadas",
    statsManagersLabel: "Gestores Alocados",
    statsManagersPct: "{{pct}}% de cobertura",
    statsManagersNote: "{{count}} clínicas sem gestor responsável",

    searchLabel: "Buscar clínica",
    searchPlaceholder: "Buscar por nome, CNPJ ou gestor",
    filterStatusLabel: "Status",
    filterStatusAll: "Todos os status",
    filterModalityLabel: "Modalidade",
    filterModalityAll: "Todas as modalidades",
    filterClear: "Limpar",
    filterResultCount: "{{filtered}} de {{total}} clínicas",
    export: "Exportar CSV",

    tableCaption: "Clínicas cadastradas",
    colName: "Nome da Clínica",
    colModalities: "Modalidades",
    colCnpj: "CNPJ",
    colAddress: "Endereço",
    colManager: "Gestor Responsável",
    colStatus: "Status",
    colActions: "Ações",
    notRecorded: "Não informado",
    branchMatriz: "Matriz",
    branchFilial: "Filial",
    noManager: "Sem gestor",

    statusActive: "Ativo",
    statusInactive: "Inativo",

    actionView: "Ver detalhes",
    actionEdit: "Editar",
    actionDeactivate: "Desativar",
    actionReactivate: "Reativar",

    confirmDeactivateTitle: "Desativar clínica",
    confirmDeactivateBodyWithResources:
      "{{name}} deixará de aceitar login de seus usuários. Seus {{equipmentCount}} equipamentos e {{unitCount}} unidades vinculadas não são desativados individualmente, e uma sessão em andamento não é encerrada. O cadastro é preservado e pode ser reativado depois.",
    confirmDeactivateBodyNoResources: "{{name}} deixará de aceitar login de seus usuários. O cadastro é preservado e pode ser reativado depois.",
    confirmDeactivateConfirm: "Desativar",
    confirmCancel: "Cancelar",

    pageSizeLabel: "Linhas por página",
    paginationSummary: "Mostrando {{from}} a {{to}} de {{total}} clínicas",
    paginationPrev: "Página anterior",
    paginationNext: "Próxima página",
    paginationPage: "Página {{page}}",

    loading: "Carregando...",
    loadError: "Não foi possível carregar as clínicas.",
    retry: "Tentar novamente",
    empty: "Nenhuma clínica cadastrada ainda.",
    emptyFiltered: "Nenhuma clínica corresponde aos filtros aplicados.",
    genericActionError: "Não foi possível concluir esta ação.",
  },

  /** The dedicated create/edit/read-only form for one clinic. */
  clinicForm: {
    breadcrumbHome: "Início",
    breadcrumbList: "Clínicas",
    breadcrumbNew: "Cadastrar Nova Clínica",
    breadcrumbEdit: "Editar Clínica",
    breadcrumbView: "Detalhes da Clínica",

    createTitle: "Cadastrar Nova Clínica",
    createSubtitle: "Preencha as informações institucionais e de contato para integrar a clínica à rede RadLink.",
    editTitle: "Editar Clínica",
    editSubtitle: "Atualize os dados institucionais, o endereço e o gestor responsável desta clínica.",
    viewTitle: "Detalhes da Clínica",
    viewSubtitle: "Visualização somente leitura do cadastro desta clínica.",
    requiredLegend: "Campos com * são obrigatórios",

    sectionInstitutional: "Dados Institucionais e Gerais",
    sectionAddress: "Endereço Institucional",
    sectionManager: "Responsável pela Clínica",

    nameLabel: "Nome da clínica",
    nameHint: "Nome fantasia reconhecido pelo sistema de laudos e cockpit.",
    namePlaceholder: "Clínica do Rafael Diagnósticos",
    cnpjLabel: "CNPJ",
    cnpjHint: "Utilizado para validação fiscal e identificação de matriz/filial. Não pode ser alterado após o cadastro.",
    cnpjPlaceholder: "12.345.678/0001-90",
    institutionalEmailLabel: "E-mail institucional",
    institutionalEmailHint: "Receberá alertas críticos de exames e relatórios administrativos.",
    institutionalEmailPlaceholder: "contato@clinica.com.br",
    phoneLabel: "Telefone de contato",
    phonePlaceholder: "(11) 3456-7890",

    zipCodeLabel: "CEP",
    zipCodeHint: "Apenas o formato é validado (8 dígitos) -- não há consulta à base dos Correios.",
    zipCodePlaceholder: "03042-001",
    streetLabel: "Rua / Logradouro",
    streetPlaceholder: "Rua Vergueiro",
    numberLabel: "Número",
    numberPlaceholder: "1234",
    complementLabel: "Complemento (opcional)",
    complementPlaceholder: "Bloco B - Sala 402",
    districtLabel: "Bairro",
    districtPlaceholder: "Centro",
    cityLabel: "Cidade",
    cityPlaceholder: "São Paulo",
    stateLabel: "UF",
    statePlaceholder: "Selecione...",

    managerLabel: "Gestor responsável",
    managerHint: "Deve ser um CLINIC_ADMIN já cadastrado nesta clínica.",
    managerPlaceholder: "Selecione...",
    managerUnassign: "(nenhum -- deixar sem gestor responsável)",
    managerNone: "Nenhum gestor responsável atribuído.",
    managerLoadError: "Não foi possível carregar os gestores elegíveis desta clínica.",
    managerCreateNote:
      "Uma clínica recém-criada ainda não possui usuários. Cadastre o primeiro administrador em Gestores & Usuários e volte aqui para atribuí-lo como responsável.",
    professionalRegistration: "Registro profissional: {{value}}",

    branchLabel: "Vínculo de matriz/filial",
    branchDerivedNote: "Derivado automaticamente do CNPJ -- não é um campo editável.",
    branchMatriz: "Matriz",
    branchFilial: "Filial",

    save: "Salvar Clínica",
    saving: "Salvando...",
    cancel: "Cancelar",
    backToList: "Voltar para clínicas",
    editThis: "Editar clínica",
    genericSaveError: "Não foi possível salvar a clínica.",
    loadError: "Não foi possível carregar esta clínica.",
    loading: "Carregando...",
  },

  /**
   * NursingPage (`/enfermagem`) -- the Nurse role's quick-action screen for the "Patient
   * Positioned" / "Injected" / "Patient Released" business rule. Built from a RadLink Teleop
   * prototype mock, and -- following this codebase's established policy (see `adminClinics`'s
   * own docstring above for the precedent) -- everything the mock showed that this platform
   * does not actually do is not reproduced here, specifically and deliberately:
   *
   * - **PACS/DICOM sync pills ("PROTOCOLO DICOM WS", "Sincronizado"), the "GRID DICOM
   *   CLÍNICO" topbar concept, "DICOM PACS 14 v3.8.4 HIPAA", "CERTIFICAÇÃO ANVISA CLASSE II /
   *   DICOM GSDF Compliant"**. No PACS/DICOM integration exists anywhere in this codebase --
   *   `Equipment.aeTitle`/`dicomIp`/`dicomPort` are inert metadata, never used to open a real
   *   DICOM association (see docs/pikvm-integration.md).
   * - **Voice PTT ("Falar com Operador"), room microphone/audio, and the free-text chat +
   *   room macros ("CONT" / "PL" / "TB" / "INT" / "PSM")**. No voice/intercom channel and no
   *   chat feature exist. The one real communication surface between clinic and remote
   *   operator is `SessionPage`'s own "Type text" panel (`PRINT_TEXT`), which the Biomédico
   *   Operador's console already has; duplicating a second, unaudited free-text channel here
   *   would undercut that one's own audit trail.
   * - **Room telemetry ("Porta Chumbo: Travada", "Clima Sala: 19.4°C", "Parada Emergencial:
   *   Operante")**. No sensor/telemetry integration of any kind exists; none of these values
   *   would be honest to display.
   * - **"Intercorrência" / "Parada Emergencial" buttons**. The one real emergency control in
   *   this codebase is `SessionsController`'s `release-all` (unstick keys) endpoint, already
   *   surfaced on `SessionPage` for the Biomédico Operador who is actually driving the
   *   equipment -- the nurse in the room has no equivalent real action to trigger.
   * - **Triage questionnaire / allergies, the digital medical order, contrast dose/
   *   concentration, patient weight/sex/age, and free-text nursing observations**. None of
   *   this exists on `QueueEntry` (`patientFirstName` only, by deliberate PHI minimization --
   *   see docs/architecture.md) or anywhere else in the data model. Adding it was considered
   *   and explicitly deferred rather than invented for this pass.
   * - **Invented `#TR-84920`-style exam codes, and the Cockpit/Exames/Enfermagem/Supervisão/
   *   Equipamentos horizontal top nav**. This app's real chrome is `ConsoleShell`'s sidebar
   *   (see its own docstring for the same policy applied to an earlier pass); this page adds
   *   one more item to that sidebar rather than building a second, parallel nav.
   *
   * What IS real and reproduced: the per-equipment patient queue (`GET /queue`), the three
   * quick-action buttons over `POST /queue/:id/preparation`, live updates via
   * `PATIENT_PREPARATION_UPDATED`/`QUEUE_UPDATED`, and the operational lock banner -- which
   * mirrors a real, database-enforced rule (`sessions_one_active_per_equipment`), not a UI
   * fiction: the remote operator genuinely cannot start the next patient's session while the
   * current one is open.
   *
   * Added alongside the queue-reorder/exam-details feature (a follow-up task on the same
   * role, same source mock's "Modo Reordenação de Fila" screen): drag/arrow reordering of
   * the room's WAITING patients (`POST /queue/reorder`) and an editable exam-detail form
   * (`PATCH /queue/:id`) per patient, with a real "Salvar Alterações deste Paciente" button.
   * That mock's own PDF uploads, prontuário/CNS/full-name fields, "Console Remoto" chat/
   * audio, and Trilha de Auditoria panel are not reproduced -- see NursingPage's own
   * docstring for exactly why each one isn't (no file storage, first-name-only PHI posture,
   * no messaging/audio transport, and NURSING deliberately outside AuditController's
   * @Roles, respectively).
   *
   * Added alongside the day-view feature (a third task, same role, a *different* source
   * mock -- the full "Fila da Sala 1, Tomografia" day screen): the day-scoped queue itself
   * (`?date=`, always today), a real room-context header, read-only-by-default exam details
   * with an explicit "Habilitar Edição" toggle, the structured safety questionnaire
   * (fasting/creatinine/allergy/contrast-volume -- what the *previous* paragraph's own
   * "triage questionnaire... explicitly deferred" note deferred, now built as real
   * `QueueEntry` columns), write attribution ("Registrado às HH:mm por <nome>"), a "Novo
   * Exame" modal, and a per-exam timeline + "Operador Remoto" card standing in for that
   * mock's own Chat/Áudio/Segurança-da-Sala panels (still no messaging, audio, or sensor
   * telemetry anywhere in this codebase). See `NursingPage`'s own docstring for the full
   * table of what that mock showed and this pass still doesn't build.
   *
   * Added alongside the exam-data-summary feature (a fourth task, same role plus
   * `LOCAL_SUPERVISOR`, a *fourth* source mock -- the Teleoperação cockpit's own "Dados do
   * Exame · Paciente em Preparação" panel): a read-only summary of Exam Type, Sex, Weight,
   * the pre-exam questionnaire, and clinical observations, shown automatically in the same
   * "Detalhes do Exame" card while the current patient's `preparationStatus` is
   * `NOT_STARTED` ("Awaiting Positioning" -- see `isAwaitingPositioning` in
   * queue-display.ts for why that's the honest mapping, not a new status value). Originally
   * built as a separate layered overlay on top of that card; merged into one card, one
   * toggle (read-only summary <-> the existing editable form) a pass later, once a real bug
   * report showed the overlay hiding that same card's own "Habilitar Edição" button -- see
   * `NursingPage`'s own docstring for that history. That mock's own digital Pedido Médico
   * (physician name/CRM, ICP-Brasil signature, "Visualizar Pedido"), computed contrast dose
   * ("1,25 ml/kg"), patient age, and invented protocol code ("TC-TORAX-02") are not
   * reproduced -- see `NursingPage`'s own docstring for exactly why each one isn't (same
   * no-file-storage/no-computed-dosing/PHI-minimization reasons as every prior pass on this
   * screen).
   */
  nursing: {
    heading: "Enfermagem",
    roomLabel: "Sala / Equipamento",
    roomPlaceholder: "Selecione um equipamento...",
    noEquipment: "Nenhum equipamento cadastrado para sua clínica.",
    loading: "Carregando...",
    loadError: "Não foi possível carregar a fila deste equipamento.",
    retry: "Tentar novamente",

    lockBannerTitle: "Trava Operacional Ativa",
    lockBannerBodyKnownOperator:
      "Enquanto o exame atual não for concluído por {{operatorName}}, a fila deste equipamento permanece travada.",
    lockBannerBodyUnknownOperator: "Enquanto o exame atual não for concluído pelo operador remoto, a fila deste equipamento permanece travada.",

    queueHeading: "Fila da Sala · {{count}} Pacientes Hoje",
    queueEmpty: "Fila vazia.",
    colPosition: "#",
    colPatient: "Paciente",
    colStatus: "Status",
    colPreparation: "Preparo",

    queueStatusWaiting: "Em espera",
    queueStatusInProgress: "Em exame",
    queueStatusDone: "Concluído",
    queueStatusCancelled: "Cancelado",

    prepNotStarted: "Não iniciado",
    prepPositioned: "Posicionado",
    prepInjected: "Injetado",
    prepReleased: "Liberado",

    actionsHeading: "Ações Rápidas de Status da Enfermagem",
    actionsSubheading: "Atualiza o status do paciente em tempo real no Painel do Biomédico Operador.",
    noCurrentPatient: "Nenhum paciente em espera ou em exame neste equipamento.",

    stepPositioned: "Paciente Posicionado",
    stepInjected: "Injetado",
    stepReleased: "Paciente Liberado",
    stepDoneAt: "Registrado às {{time}}",
    stepBlockedBySession: "Aguardando conclusão do exame pelo Biomédico Operador.",
    actionError: "Não foi possível atualizar o status do paciente.",

    // --- Queue reorder -----------------------------------------------------------------
    reorderColHandle: "Ordem",
    colExam: "Exame",
    reorderBannerTitle: "Alterações de Ordem Não Confirmadas",
    reorderBannerBody: "{{count}} paciente(s) fora da ordem atual da fila. Confirme para aplicar, ou descarte para voltar à ordem original.",
    restoreOriginalOrder: "Restaurar Ordem Original",
    cancelChanges: "Cancelar Alterações",
    confirmNewSequence: "Confirmar Nova Sequência",
    reorderSaving: "Salvando nova sequência...",
    reorderError: "Não foi possível salvar a nova sequência da fila.",
    moveUp: "Antecipar {{patient}} na fila",
    moveDown: "Postergar {{patient}} na fila",
    moveAnnouncement: "{{patient}} movido para a posição {{position}} de {{total}}.",
    notReorderable: "Não pode ser reordenado -- paciente já em exame, concluído ou cancelado.",
    staleQueueNotice: "A fila foi alterada em outro dispositivo enquanto você reordenava. Recarregue para ver a versão atual.",
    reloadQueue: "Recarregar Fila",

    // --- Exam details (per-patient editable form) --------------------------------------
    selectToEdit: "Selecionar para Editar",
    selected: "Selecionado",
    detailsHeading: "Detalhes do Exame",
    detailsSubheading: "Editável apenas enquanto o paciente está em espera ou em exame.",
    detailsNoSelection: "Selecione um paciente na fila para editar os detalhes do exame.",
    detailsLockedNote: "Este atendimento já foi concluído ou cancelado -- os detalhes não podem mais ser editados.",
    examDescriptionLabel: "Tipo do Exame",
    examDescriptionPlaceholder: "Ex.: RM Crânio c/ Contraste",
    contrastRequiredLabel: "Requer contraste",
    patientSexLabel: "Sexo",
    patientSexPlaceholder: "Não informado",
    patientSexFemale: "Feminino",
    patientSexMale: "Masculino",
    patientSexOther: "Outro",
    patientWeightLabel: "Peso Corporal (kg)",
    scheduledAtLabel: "Horário Previsto",
    preparationNotesLabel: "Observações Clínicas",
    preparationNotesPlaceholder: "Jejum, acessos, alergias, orientações para a teleoperação...",
    saveDetails: "Salvar Alterações deste Paciente",
    discardDetails: "Descartar Edição",
    detailsSaving: "Salvando...",
    detailsError: "Não foi possível salvar os detalhes do exame.",
    detailsStaleNotice: "Este paciente foi atualizado em outro dispositivo. Recarregar descarta suas alterações não salvas.",
    reloadDetails: "Recarregar Detalhes",

    // --- Room header (day-view feature) -------------------------------------------------
    cardRank: "#{{position}}",

    // --- Read-only / edit toggle ---------------------------------------------------------
    readOnlyBadge: "Modo Somente Leitura",
    editModeBadge: "Em Edição",
    enableEditing: "Habilitar Edição",

    // --- "Novo Exame" modal ---------------------------------------------------------------
    newExamButton: "Novo Exame",
    newExamModalTitle: "Novo Exame",
    newExamPatientNameLabel: "Nome do Paciente",
    newExamScheduledTimeLabel: "Horário Previsto",
    newExamSubmit: "Adicionar à Fila",
    newExamCancel: "Cancelar",
    newExamNameRequired: "Informe o nome do paciente.",
    newExamError: "Não foi possível adicionar o paciente à fila.",

    // --- Safety questionnaire ("Questionário de Segurança & Contraste") -----------------
    questionnaireHeading: "Questionário de Segurança & Contraste",
    contrastVolumeLabel: "Volume de Contraste (ml)",
    fastingConfirmedLabel: "Jejum confirmado",
    fastingHoursLabel: "Horas de jejum",
    creatinineLabel: "Creatinina (mg/dL)",
    allergyStatusLabel: "Alergias",
    allergyStatusPlaceholder: "Não informado",
    allergyStatusNegated: "Negadas",
    allergyStatusPresent: "Registradas",
    allergyNotesLabel: "Descrição da Alergia",
    cardChipFastingAlert: "Alerta Jejum",

    // --- Write attribution ----------------------------------------------------------------
    attributionLine: "Registrado às {{time}} por {{name}}",
    attributionUnknown: "usuário não identificado",

    // --- Right column: operator card + per-exam timeline ---------------------------------
    operatorCardHeading: "Operador Remoto",
    operatorCardNone: "Nenhum operador conectado a esta sala no momento.",
    operatorOnlineBadge: "ONLINE",
    // Renders `ExamChat` (shared with ExamPage) -- see that component's own docstring for
    // why nursing can now send and receive this chat at all.
    chatHeading: "Canal Direto · Sala ⇄ Central",
    chatLoadError: "Não foi possível carregar o histórico do chat.",
    chatShortcutError: "Não foi possível criar este atalho.",
    timelineHeading: "Linha do Tempo do Atendimento",
    timelineNoSelection: "Selecione um paciente na fila para ver a linha do tempo do atendimento.",
    timelineEmpty: "Nenhum evento registrado ainda para este atendimento.",
    timelineLoadError: "Não foi possível carregar a linha do tempo deste atendimento.",
    timelineActionCreated: "Paciente adicionado à fila",
    timelineActionDetailsUpdated: "Detalhes do exame atualizados",
    timelineActionPositioned: "Paciente Posicionado",
    timelineActionInjected: "Injetado",
    timelineActionReleased: "Paciente Liberado",

    // --- Exam-data overlay ("Aguardando Posicionamento") -------------------------------
    // See ExamDataOverlay's own docstring and isAwaitingPositioning in queue-display.ts:
    // this is a contextual label for PreparationStatus.NOT_STARTED, not a new status --
    // prepNotStarted above ("Não iniciado") is unchanged and still used by the queue chips.
    // --- Exam-data summary (read-only view, shown for the current room's patient while
    // "Aguardando Posicionamento" -- see isAwaitingPositioning in queue-display.ts) --------
    awaitingPositioningBadge: "Aguardando Posicionamento",
    notInformed: "Não informado",
    awaitingConfirmationNote: "Aguardando confirmação de posicionamento.",
    observationsHeading: "Observações Clínicas",
    noObservations: "Nenhuma observação clínica registrada.",
    contrastRequiredNote: "Contraste requerido",
    contrastRequiredVolumeNote: "Contraste requerido · {{volume}} ml",
    contrastNotRequiredNote: "Sem contraste",
    fastingConfirmedNote: "Jejum confirmado",
    fastingConfirmedHoursNote: "Jejum confirmado · {{hours}} h",
    fastingNotConfirmedNote: "Jejum não confirmado",

  },

  /**
   * The Biomédico Operador's post-login workstation-selection screen (`/posto-de-trabalho`,
   * `WorkstationPage.tsx`) -- built from a "Selecione seu Perfil e Posto de Trabalho" RadLink
   * mock. `roles`/`permissions` cover the profile card; this namespace covers everything
   * around it.
   *
   * Not reproduced from that mock, each for a specific, existing reason (same policy as
   * every prior feature built from a screenshot -- see `nursing`'s own docstring for the
   * precedent):
   *
   * | Prototype element | Why not |
   * |---|---|
   * | Three selectable profile cards, "Ativo" pill, "Biomédico pré-selecionado" hint | Role is never chosen by the user -- it comes from the JWT and is enforced by every controller's own `@Roles` (see `role-routes.ts`). Replaced with a read-only `IdentityCard` + `RolePermissionSummary`, the same two components the reset/forced-change screens already use for "who is this and what can they do" |
   * | "ETAPA 1 DE 2" | There is no second step -- this screen has exactly one job (pick a unit and room), unlike the mock's implied multi-step wizard |
   * | "VPN Segura: 14ms" topbar pill | No VPN/tunnel-latency measurement exists anywhere in this codebase -- `use-latency` measures in-session WHEP round-trip, not network-path health, and `ConsoleShell`'s own topbar already dropped an equivalent fabricated pill for the same reason (see its own docstring) |
   * | "Sala CT-01: GE Revolution CT" detail card's "Link Ativo (Fibra Redundante)" and "Latência: 16ms" | No link-topology or per-equipment latency probe exists. Replaced with the two facts that *are* real: the equipment's own health-poller status (`EquipmentDto.status`, already used everywhere else -- `displayStatusOf`) and today's real patient-queue count for that room |
   * | "Confirmar e Acessar Cockpit" | Confirm now navigates straight to `/exame?equipmentId=…` (see `ExamPage`'s own docstring) -- that screen's own "start the next exam" prompt is what actually starts the session, so this button still does not create one itself |
   * | "Cancelar / Voltar ao Login" footer link | The user is already authenticated to reach this screen at all; `ConsoleShell`'s topbar already has "Sair" for signing out |
   */
  workstation: {
    heading: "Selecione seu Posto de Trabalho",
    intro: "As permissões, atalhos e a sala de exame ativa serão ajustados com base no seu perfil e na sala escolhida abaixo.",

    accessProfileTitle: "Perfil de Acesso no Turno",

    /**
     * The clinic step -- new since a contracted operator's home tenant owns no clinic of its
     * own (see `roles.ts`'s role-model inversion): unlike the unit/room steps below, this one
     * is never skippable for `OPERATOR`, because there is no default clinic to fall back to.
     * `clinicLabel`/`clinicPlaceholder` are also reused verbatim by `DashboardPage`'s own,
     * much smaller clinic selector -- same concept, same wording, no reason to duplicate it.
     */
    clinicSectionTitle: "Clínica Contratada",
    clinicLabel: "Clínica",
    clinicPlaceholder: "Selecione a clínica...",
    clinicLoadError: "Não foi possível carregar suas clínicas.",
    noClinics: "Sua operadora ainda não possui contratos ativos com nenhuma clínica.",
    clinicSwitchError: "Não foi possível acessar esta clínica. Verifique se o contrato ainda está ativo.",
    switchingClinic: "Acessando clínica...",
    unitPlaceholderNoClinic: "Selecione uma clínica primeiro",
    // DashboardPage's own empty state, shown only when contracted clinics exist but none has
    // been entered yet -- distinct from "no equipment registered", which would otherwise
    // misdescribe an operator who simply hasn't picked a clinic as a clinic with nothing in it.
    dashboardNoClinicSelected: "Selecione uma clínica para ver os equipamentos desta organização.",

    physicalConnectionTitle: "Conexão Física: Unidade e Sala",
    unitLabel: "Unidade de Atendimento",
    unitPlaceholder: "Selecione uma unidade...",
    unitLoadError: "Não foi possível carregar as unidades.",
    noUnits: "Nenhuma unidade cadastrada para sua clínica ainda.",

    roomLabel: "Equipamento & Sala",
    roomPlaceholderNoUnit: "Selecione uma unidade primeiro",
    roomPlaceholderChoose: "Selecione uma sala...",
    roomLoadError: "Não foi possível carregar os equipamentos.",
    noRoomsForUnit: "Esta unidade não possui equipamentos cadastrados.",

    roomStatusQueueCount: "{{count}} paciente(s) na fila hoje",
    roomStatusQueueCountZero: "Nenhum paciente na fila hoje",
    roomStatusQueueError: "Não foi possível carregar a fila desta sala.",

    offlineNotice: "Este equipamento está offline no momento -- a fila da sala ainda pode ser consultada.",

    scopedRoomNotFound: "Esta sala não foi encontrada. Verifique se você selecionou a unidade e a sala corretas.",

    confirm: "Confirmar e Acessar Sala",
    switchWorkstation: "Trocar posto de trabalho",
    retry: "Tentar novamente",
  },

  /**
   * Clinic <-> operating-company contracts (`AgreementsPage`). One namespace for both sides, since
   * it is one screen -- the `subtitleClinic`/`subtitleOperator` pair is the only place the wording
   * actually diverges, and the column headers swap rather than duplicate.
   *
   * The status labels are the business vocabulary, not the enum names: "Aguardando resposta" says
   * what PENDING means to whoever is looking at it, and "Encerrado" vs "Recusado" preserves the
   * distinction the model draws between a contract that ended and a proposal that never started
   * (see AgreementStatus's own docstring for why those are not collapsed).
   */
  agreements: {
    loading: "Carregando...",
    saving: "Salvando...",
    cancel: "Cancelar",
    pageTitle: "Contratos de Teleoperação",
    heading: "Contratos de Teleoperação",
    subtitleClinic: "Empresas de operação remota autorizadas a operar os equipamentos desta clínica.",
    subtitleOperator: "Clínicas que contrataram sua empresa para operação remota.",
    propose: "Propor contrato",
    proposeTitle: "Propor novo contrato",
    proposeSubmit: "Enviar proposta",
    proposeHint: "A outra parte precisa aceitar antes que qualquer acesso seja concedido.",
    pickClinic: "Clínica",
    pickOperator: "Empresa operadora",
    pickPlaceholder: "Selecione...",
    filterStatus: "Situação",
    statusAll: "Todas",
    statusPending: "Aguardando resposta",
    statusActive: "Ativo",
    statusRejected: "Recusado",
    statusRevoked: "Encerrado",
    resultCount: "{{count}} contrato(s)",
    empty: "Nenhum contrato encontrado.",
    tableCaption: "Lista de contratos de teleoperação",
    colClinic: "Clínica",
    colOperator: "Empresa operadora",
    colStatus: "Situação",
    colScope: "Abrangência",
    colActions: "Ações",
    accept: "Aceitar",
    reject: "Recusar",
    revoke: "Encerrar",
    editScope: "Abrangência",
    scopeEmpty: "Nenhuma unidade liberada — sem acesso",
    scopeTitle: "Abrangência: {{name}}",
    scopeLegend: "Unidades liberadas para esta empresa",
    scopeHint: "A empresa só acessa os equipamentos das unidades marcadas. Equipamentos instalados depois em uma unidade marcada já entram liberados.",
    scopeSubmit: "Salvar abrangência",
    scopeNoUnits: "Esta clínica ainda não possui unidades cadastradas.",
    scopeUnitHint: "{{count}} equipamento(s)",
    loadFailed: "Não foi possível carregar os contratos.",
    actionFailed: "Não foi possível concluir a ação.",
    proposeFailed: "Não foi possível enviar a proposta.",
    counterpartyLoadFailed: "Não foi possível carregar as organizações disponíveis.",
    scopeLoadFailed: "Não foi possível carregar as unidades desta clínica.",
    scopeSaveFailed: "Não foi possível salvar a abrangência.",
  },

  /**
   * `ExamPage` -- the remote operator's cockpit (see that page's own docstring for the full
   * "reproduced vs. deliberately not" reasoning against its own source mock). Reuses several
   * `nursing:` keys directly (queue-card chip labels, `cardRank`) rather than duplicating them
   * here -- `QueueStrip` requests both namespaces for exactly that reason.
   */
  exam: {
    heading: "Exame -- {{room}}",
    loading: "Carregando...",
    loadError: "Não foi possível carregar esta sala.",
    noEquipmentSelected: "Nenhum equipamento selecionado.",
    backToWorkstation: "Voltar ao posto de trabalho",

    startExamHeading: "Iniciar Exame",
    startExamWithPatient: "Próximo paciente: {{patient}}",
    startExamNoPatient: "Nenhum paciente na fila -- o exame pode ser iniciado mesmo assim.",
    startExamButton: "Iniciar Exame",
    starting: "Iniciando...",
    startError: "Não foi possível iniciar o exame.",
    equipmentOffline: "Este equipamento está offline -- não é possível iniciar um exame agora.",

    queueHeading: "Fila do Dia",
    queueEmpty: "Nenhum paciente na fila hoje.",

    roomCameraHeading: "Câmera da Sala",

    chatHeading: "Chat da Sala",
    chatEmpty: "Nenhuma mensagem neste dia.",
    chatLoadError: "Não foi possível carregar o histórico do chat.",
    chatInputLabel: "Mensagem",
    chatInputPlaceholder: "Escreva uma mensagem...",
    unknownAuthor: "Autor desconhecido",
    send: "Enviar",
    sending: "Enviando...",
    sendError: "Não foi possível enviar a mensagem.",
    historyLabel: "Histórico:",
    historyToday: "Hoje",
    attachFile: "Anexar arquivo",
    removeAttachment: "Remover anexo",
    downloadAttachment: "Baixar anexo",
    attachmentTypeError: "Tipo de arquivo não permitido. Envie uma imagem (PNG/JPEG/WEBP) ou um PDF.",
    attachmentSizeError: "O arquivo excede o limite de 10MB.",

    createShortcut: "Criar Atalho",
    createShortcutTitle: "Novo atalho de resposta rápida",
    shortcutCodeLabel: "Código (exibido no botão)",
    shortcutLabelLabel: "Nome",
    shortcutBodyLabel: "Texto da mensagem",
    shortcutError: "Não foi possível criar este atalho.",
    cancel: "Cancelar",
    save: "Salvar",
    saving: "Salvando...",

    notInControl: "Você não está no controle deste exame. A entrada está desabilitada.",
    consoleAriaLabel: "Console remoto de {{room}}. Quando em foco, teclado e mouse são enviados diretamente ao equipamento.",
    takeOver: "Assumir controle",
    returnControl: "Devolver controle ao operador",
    viewReplay: "Ver replay",
    endExam: "Finalizar Exame",
    ending: "Finalizando...",
    endError: "Não foi possível finalizar o exame.",
    // The right column's own bottom action button -- deliberately worded differently from
    // the header's "Finalizar Exame" (see the mock's own "Finalizar Exame & Liberar Sala")
    // so the two never collide as the same accessible name on one page.
    endExamAndReleaseRoom: "Finalizar Exame & Liberar Sala",
    emergencyRelease: "Liberação de emergência (destravar teclas)",
    releasing: "Liberando...",
    releaseError: "Não foi possível liberar a entrada. Tente novamente.",

    typeTextHeading: "Digitar Texto",
    typeTextInputLabel: "Texto para digitar no equipamento remoto",
    typeTextPlaceholder: "ID do paciente, nome...",
    typeTextSend: "Enviar ao Equipamento",
    typeTextSent: "✓ Enviado ao equipamento",

    sessionCardHeading: "Exame Atual",
    operatorLabel: "Operador",
    controllerLabel: "No controle",

    patientCardHeading: "Ficha do Paciente Ativo",
    patientCardEmpty: "Nenhum paciente selecionado.",
    alertsCardHeading: "Alertas Clínicos & Segurança",
    patientExamLabel: "Exame",
    patientSexLabel: "Sexo",
    patientWeightLabel: "Peso",
    contrastLabel: "Contraste",
    contrastYes: "Sim",
    fastingLabel: "Jejum",
    fastingYes: "Confirmado",
    allergyLabel: "Alergia",
    creatinineLabel: "Creatinina",
    nursingNotesLabel: "Observações da Enfermagem",
    teleoperationNotesLabel: "Notas do Operador Remoto",
    notesLockedNote: "Este exame já foi concluído ou cancelado -- as notas não podem mais ser editadas.",
    notesError: "Não foi possível salvar as notas.",
    close: "Fechar",
  },

  // The equipment/patient-queue landing page for every role except OPERATOR/NURSING (see
  // role-routes.ts) -- DashboardPage.tsx. Reuses `adminEquipment:status*` for the equipment
  // status badge and `nursing:queueStatus*` for the per-patient queue status, the same way
  // that page already reuses `workstation:*` for its clinic-picker/scoped-room strings --
  // one enum, one set of labels, never redefined per screen.
  dashboard: {
    heading: "Painel de Equipamentos",
    loading: "Carregando...",
    noEquipment: "Nenhum equipamento registrado para o seu tenant ainda.",
    loadError: "Não foi possível carregar os equipamentos. Verifique sua conexão e tente novamente.",
    retry: "Tentar novamente",
    auditLog: "Log de Auditoria",
    rejoinSession: "Reingressar na Sessão",
    startSession: "Iniciar Sessão",
    starting: "Iniciando...",
    startSessionError: "Não foi possível iniciar a sessão.",
    // {{status}} is the same translated equipment-status word the badge itself shows
    // (adminEquipment:status*), so this reads e.g. "Equipamento está Offline, inacessível"
    // rather than mixing a pt-BR sentence with a raw English enum value.
    equipmentOfflineTitle: "Equipamento está {{status}}, inacessível",
    keymapWord: "layout",
    patientQueueHeading: "Fila de Pacientes",
    queueEmpty: "Vazia.",
    colNumber: "#",
    colPatient: "Paciente",
    colStatus: "Status",
    colActions: "Ações",
    cancel: "Cancelar",
    addPatientLabel: "Adicionar um paciente à fila de {{name}}",
    patientNamePlaceholder: "Nome do paciente",
    addToQueue: "Adicionar à Fila",
    addPatientError: "Não foi possível adicionar este paciente à fila.",
    cancelQueueEntryError: "Não foi possível cancelar esta entrada da fila.",
  },

  // AuditPage.tsx -- the append-only hash-chain log, reachable from DashboardPage's own
  // "Log de Auditoria" link (dashboard:auditLog). `action`/`resourceType` in the table stay
  // untranslated on purpose: they're the exact `AuditAction`/resource-type identifiers this
  // log's own integrity guarantee (see AuditAction's own docstring) is about, the same reason
  // a stack trace or an HTTP method name would not get localized either -- translating them
  // would trade a precise technical label for an approximate one, in the one screen where
  // precision is the entire point.
  audit: {
    heading: "Log de Auditoria",
    backToDashboard: "Voltar ao Painel",
    verifyChain: "Verificar Cadeia de Hash",
    verifying: "Verificando cadeia...",
    verifyPass: "PASSOU — {{count}} linhas verificadas, cadeia intacta.",
    verifyFail: "FALHOU — violação detectada na sequência #{{seq}}.",
    verifyError: "Não foi possível verificar a cadeia de hash.",
    loading: "Carregando...",
    loadError: "Não foi possível carregar o log de auditoria.",
    retry: "Tentar novamente",
    tableCaption: "Entradas do log de auditoria, mais recentes primeiro",
    colSeq: "Seq",
    colTimestamp: "Data/Hora",
    colAction: "Ação",
    colResource: "Recurso",
    colSession: "Sessão",
    colHash: "Hash",
  },
} as const;

export default ptBR;

