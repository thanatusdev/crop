import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BR_STATES,
  EstablishmentType,
  ExamModality,
  type MyClinic,
  type TechnicalManagerOption,
  type TenantDto,
  type UnitDto,
} from "@crop/shared";
import { api, ApiError } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { CheckboxCardGroup, type CheckboxCardOption } from "../components/CheckboxCardGroup.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Switch } from "../components/ui/switch.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { MODALITY_ORDER } from "../lib/equipment-display.js";
import { ESTABLISHMENT_TYPE_LABEL_KEY, ESTABLISHMENT_TYPE_ORDER } from "../lib/unit-display.js";

// Radix `Select.Item` rejects an empty-string `value` -- this stands in for "explicitly no
// technical manager," a real, selectable state in edit/view mode (never offered in create
// mode, where a manager is required), mapped to/from `""` at the read/write boundary below.
const MANAGER_UNASSIGNED = "__unassigned__";

type Mode = "create" | "edit" | "view";

/**
 * The subset of `TechnicalManagerOption` (from `GET /units/technical-managers`) this form
 * actually renders -- `id`/`name` for the `<select>`, `professionalRegistration` for the
 * hint line underneath. Narrower on purpose: `UnitDto.technicalManager` (what a *loaded*
 * unit denormalizes about its own chosen manager) carries exactly these three fields and no
 * `email`/`role`, so this is the shape both that and the candidates list can share without
 * fabricating values for the fields the loaded unit doesn't have.
 */
type ManagerOption = Pick<TechnicalManagerOption, "id" | "name" | "professionalRegistration">;

// Distinct from `equipmentForm`'s own modality label/hint keys: the hints differ (a unit's
// modality picker describes hardware tiers -- "1.5T / 3.0T Alto Campo" -- where the
// equipment form's describes the exam itself), and this mapping is used nowhere else, so it
// stays local rather than joining `lib/equipment-display.ts`'s shared exports.
const UNIT_MODALITY_LABEL_KEY: Record<
  ExamModality,
  "unitForm:modalityMri" | "unitForm:modalityCt" | "unitForm:modalityUltrasound" | "unitForm:modalityXray"
> = {
  [ExamModality.MRI]: "unitForm:modalityMri",
  [ExamModality.CT]: "unitForm:modalityCt",
  [ExamModality.ULTRASOUND]: "unitForm:modalityUltrasound",
  [ExamModality.XRAY]: "unitForm:modalityXray",
};
const UNIT_MODALITY_HINT_KEY: Record<
  ExamModality,
  "unitForm:modalityMriHint" | "unitForm:modalityCtHint" | "unitForm:modalityUltrasoundHint" | "unitForm:modalityXrayHint"
> = {
  [ExamModality.MRI]: "unitForm:modalityMriHint",
  [ExamModality.CT]: "unitForm:modalityCtHint",
  [ExamModality.ULTRASOUND]: "unitForm:modalityUltrasoundHint",
  [ExamModality.XRAY]: "unitForm:modalityXrayHint",
};

interface FormState {
  name: string;
  clinicTenantId: string;
  establishmentType: EstablishmentType | "";
  active: boolean;
  cnesCode: string;
  phone: string;
  technicalEmail: string;
  zipCode: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  declaredModalities: ExamModality[];
  technicalManagerId: string;
}

function emptyForm(): FormState {
  return {
    name: "",
    clinicTenantId: "",
    establishmentType: "",
    active: true,
    cnesCode: "",
    phone: "",
    technicalEmail: "",
    zipCode: "",
    street: "",
    number: "",
    complement: "",
    district: "",
    city: "",
    state: "",
    declaredModalities: [],
    technicalManagerId: "",
  };
}

function formFrom(unit: UnitDto): FormState {
  return {
    name: unit.name,
    clinicTenantId: unit.clinicTenantId,
    establishmentType: unit.establishmentType ?? "",
    active: !unit.deactivated,
    cnesCode: unit.cnesCode ?? "",
    phone: unit.phone ?? "",
    technicalEmail: unit.technicalEmail ?? "",
    zipCode: unit.zipCode ?? "",
    street: unit.street ?? "",
    number: unit.number ?? "",
    complement: unit.complement ?? "",
    district: unit.district ?? "",
    city: unit.city ?? "",
    state: unit.state ?? "",
    declaredModalities: unit.declaredModalities,
    technicalManagerId: unit.technicalManagerId ?? "",
  };
}

/**
 * A field label carrying the required marker. Module scope, not a component declared
 * inside `UnitFormPage` -- see `EquipmentFormPage`'s identical `RequiredLabel` for why that
 * matters (a component type redeclared every render would remount its subtree every
 * keystroke instead of updating it).
 */
function RequiredLabel({ htmlFor, required, children }: { htmlFor: string; required: boolean; children: React.ReactNode }) {
  return (
    <Label htmlFor={htmlFor}>
      {children}
      {required && (
        <span className="text-destructive" aria-hidden="true">
          *
        </span>
      )}
    </Label>
  );
}

function SectionHeader({ step, title }: { step: string; title: string }) {
  return (
    <CardHeader className="flex-row items-center gap-3 space-y-0 border-b [.border-b]:pb-4">
      <span className="rounded-md bg-accent px-2 py-0.5 text-xs font-bold tabular-nums text-accent-foreground">{step}</span>
      <CardTitle className="text-sm font-semibold tracking-wide uppercase">{title}</CardTitle>
    </CardHeader>
  );
}

/**
 * Register / edit / view one unit, on its own route -- the same "three modes, one
 * component, a dedicated page rather than an inline card" shape `EquipmentFormPage` already
 * established, for the identical reason: three sections and eighteen-odd fields would bury
 * the listing table if they lived inline above it.
 *
 * The clinic a unit belongs to is selectable only at creation (and only when the caller can
 * reach more than one), and is plain read-only text in edit/view mode regardless of
 * `readOnly` -- there is no `clinicTenantId` field on `UpdateUnitRequestSchema` at all (see
 * that schema's own docstring on why reassignment isn't supported), so this is the one part
 * of the form that stays non-interactive even while everything else is editable.
 *
 * Each numbered section is its own `Card`, same "shared ancestor" reasoning as
 * `EquipmentFormPage`'s own docstring -- see docs/architecture.md's shadcn migration entries.
 */
export default function UnitFormPage() {
  const { t } = useTranslation(["unitForm", "adminUnits"]);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { id, mode: routeMode } = useParams<{ id?: string; mode?: string }>();

  const mode: Mode = !id ? "create" : routeMode === "edit" ? "edit" : "view";
  const readOnly = mode === "view";
  const isSuperadmin = user?.role === "PLATFORM_ADMIN";

  const [form, setForm] = useState<FormState>(emptyForm());
  const [tenants, setTenants] = useState<TenantDto[]>([]);
  const [myClinics, setMyClinics] = useState<MyClinic[]>([]);
  const clinicOptions = useMemo(
    () =>
      isSuperadmin
        ? tenants.filter((tenant) => tenant.type === "CLINIC").map((tenant) => ({ id: tenant.id, name: tenant.name }))
        : myClinics.map((clinic) => ({ id: clinic.id, name: clinic.name })),
    [isSuperadmin, tenants, myClinics]
  );
  function clinicName(clinicTenantId: string): string {
    return clinicOptions.find((clinic) => clinic.id === clinicTenantId)?.name ?? clinicTenantId;
  }

  const [technicalManagerOptions, setTechnicalManagerOptions] = useState<ManagerOption[]>([]);
  const [technicalManagerLoadError, setTechnicalManagerLoadError] = useState<string | null>(null);
  // The unit's own denormalized manager, captured at load time -- guarantees the select
  // always has a matching <option> even if that person has since become ineligible (locked,
  // deactivated, or role-changed) and so no longer appears in `technicalManagerOptions`.
  const [loadedManager, setLoadedManager] = useState<ManagerOption | null>(null);

  const [loading, setLoading] = useState(mode !== "create");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isSuperadmin) void loadClinicList(api.get<TenantDto[]>("/tenants"), setTenants);
    else void loadClinicList(api.get<MyClinic[]>("/auth/me/clinics"), setMyClinics);
  }, [isSuperadmin]);

  useEffect(() => {
    void load();
  }, [id, mode]);

  // Defaults a fresh create form to the caller's own home clinic, the same fallback
  // `AdminUnitsPage`'s predecessor used -- overridden the moment the operator picks a
  // different one from the select, when more than one is available.
  useEffect(() => {
    if (mode === "create" && !form.clinicTenantId && user) update("clinicTenantId", user.tenantId);
  }, [mode, user]);

  // Refetches technical-manager candidates whenever the relevant clinic changes -- fires
  // once on edit/view (the unit's own, fixed clinic) and again on create if the operator
  // changes the clinic selector.
  useEffect(() => {
    if (form.clinicTenantId) void loadTechnicalManagers(form.clinicTenantId);
  }, [form.clinicTenantId]);

  async function loadClinicList<T>(request: Promise<T[]>, setter: (list: T[]) => void) {
    try {
      setter(await request);
    } catch {
      // Non-fatal -- the clinic selector/display just falls back to a raw id.
    }
  }

  async function load() {
    setLoadError(null);
    try {
      if (id) {
        setLoading(true);
        const unit = await api.get<UnitDto>(`/units/${id}`);
        setForm(formFrom(unit));
        setLoadedManager(unit.technicalManager);
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t("unitForm:loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function loadTechnicalManagers(clinicTenantId: string) {
    setTechnicalManagerLoadError(null);
    try {
      setTechnicalManagerOptions(await api.get<TechnicalManagerOption[]>(`/units/technical-managers?clinicTenantId=${clinicTenantId}`));
    } catch {
      setTechnicalManagerLoadError(t("unitForm:technicalManagerLoadError"));
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const managerOptionsForSelect = useMemo(() => {
    if (loadedManager && !technicalManagerOptions.some((option) => option.id === loadedManager.id)) {
      return [loadedManager, ...technicalManagerOptions];
    }
    return technicalManagerOptions;
  }, [technicalManagerOptions, loadedManager]);
  const selectedManager = managerOptionsForSelect.find((option) => option.id === form.technicalManagerId);

  const modalityOptions: readonly CheckboxCardOption<ExamModality>[] = useMemo(
    () =>
      MODALITY_ORDER.map((modality) => ({
        value: modality,
        title: t(UNIT_MODALITY_LABEL_KEY[modality]),
        hint: t(UNIT_MODALITY_HINT_KEY[modality]),
      })),
    [t]
  );

  function applyServerFieldErrors(err: ApiError) {
    const mapped: Record<string, string> = {};
    for (const issue of err.fieldErrors) {
      if (issue.path) mapped[issue.path] = issue.message;
    }
    setFieldErrors(mapped);
  }

  function validate(): boolean {
    const errors: Record<string, string> = {};
    if (form.declaredModalities.length === 0) errors.declaredModalities = t("unitForm:modalityRequiredError");
    if (mode === "create" && !form.technicalManagerId) errors.technicalManagerId = t("unitForm:validationSummary");
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setSaveError(null);
    if (!validate()) return;

    setSaving(true);
    try {
      const shared = {
        name: form.name,
        establishmentType: form.establishmentType || undefined,
        declaredModalities: form.declaredModalities,
        zipCode: form.zipCode,
        street: form.street,
        number: form.number,
        complement: form.complement || null,
        district: form.district,
        city: form.city,
        state: form.state,
        cnesCode: form.cnesCode || null,
        phone: form.phone || null,
        technicalEmail: form.technicalEmail || null,
      };

      if (mode === "create") {
        const created = await api.post<UnitDto>("/units", {
          ...shared,
          clinicTenantId: form.clinicTenantId,
          technicalManagerId: form.technicalManagerId,
        });
        if (!form.active) await api.post(`/units/${created.id}/deactivate`);
        navigate("/admin/units");
        return;
      }

      await api.patch(`/units/${id}`, { ...shared, technicalManagerId: form.technicalManagerId || null });

      // Deactivation is a separate endpoint, not a PATCH field -- see EquipmentFormPage's
      // identical pattern and reasoning (a lifecycle transition with its own audit action).
      const current = await api.get<UnitDto>(`/units/${id}`);
      if (current.deactivated === form.active) {
        await api.post(`/units/${id}/${form.active ? "reactivate" : "deactivate"}`);
      }
      navigate("/admin/units");
    } catch (err) {
      if (err instanceof ApiError) applyServerFieldErrors(err);
      setSaveError(err instanceof ApiError ? err.message : t("unitForm:genericSaveError"));
    } finally {
      setSaving(false);
    }
  }

  const title = mode === "create" ? t("unitForm:createTitle") : mode === "edit" ? t("unitForm:editTitle") : t("unitForm:viewTitle");
  const subtitle = mode === "create" ? t("unitForm:createSubtitle") : mode === "edit" ? t("unitForm:editSubtitle") : t("unitForm:viewSubtitle");
  const breadcrumbLeaf =
    mode === "create" ? t("unitForm:breadcrumbNew") : mode === "edit" ? t("unitForm:breadcrumbEdit") : t("unitForm:breadcrumbView");

  if (loading) {
    return (
      <ConsoleShell activeNav="units" pageTitle={title}>
        <p aria-live="polite">{t("unitForm:loading")}</p>
      </ConsoleShell>
    );
  }

  if (loadError) {
    return (
      <ConsoleShell activeNav="units" pageTitle={title}>
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <Button variant="secondary" className="mt-3" asChild>
          <Link to="/admin/units">{t("unitForm:backToList")}</Link>
        </Button>
      </ConsoleShell>
    );
  }

  return (
    <ConsoleShell activeNav="units" pageTitle={title}>
      <nav className="mb-2.5 text-[13px] text-muted-foreground" aria-label={breadcrumbLeaf}>
        <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          <li>{t("unitForm:breadcrumbHome")}</li>
          <li>
            <span aria-hidden="true">›</span>{" "}
            <Link className="text-primary underline" to="/admin/units">
              {t("unitForm:breadcrumbList")}
            </Link>
          </li>
          <li aria-current="page">
            <span aria-hidden="true">›</span> {breadcrumbLeaf}
          </li>
        </ol>
      </nav>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mt-0 mb-1.5 text-[1.6em] font-semibold">{title}</h1>
          <p className="m-0 max-w-[60ch] text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {readOnly ? (
          <Button asChild>
            <Link to={`/admin/units/${id}/edit`}>{t("unitForm:editThis")}</Link>
          </Button>
        ) : (
          <span className="text-[13px] text-muted-foreground">{t("unitForm:requiredLegend")}</span>
        )}
      </div>

      <form onSubmit={submit}>
        <Card className="mb-4 py-0">
          <SectionHeader step="01" title={t("unitForm:sectionInstitutional")} />
          <CardContent className="grid gap-3.5 py-5">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="unit-name">
                  {t("unitForm:nameLabel")}
                </RequiredLabel>
                <Input
                  id="unit-name"
                  value={form.name}
                  placeholder={t("unitForm:namePlaceholder")}
                  onChange={(e) => update("name", e.target.value)}
                  required
                  disabled={readOnly}
                  aria-describedby="unit-name-hint"
                />
                <span className="text-xs text-muted-foreground" id="unit-name-hint">
                  {t("unitForm:nameHint")}
                </span>
              </div>

              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={mode === "create" && clinicOptions.length > 1} htmlFor="unit-clinic">
                  {t("unitForm:clinicLabel")}
                </RequiredLabel>
                {mode === "create" && clinicOptions.length > 1 ? (
                  <Select
                    value={form.clinicTenantId || undefined}
                    onValueChange={(value) => {
                      update("clinicTenantId", value);
                      update("technicalManagerId", "");
                    }}
                  >
                    <SelectTrigger id="unit-clinic" className="w-full">
                      <SelectValue placeholder={t("unitForm:clinicPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {clinicOptions.map((clinic) => (
                        <SelectItem key={clinic.id} value={clinic.id}>
                          {clinic.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="min-h-6 py-2.5 text-sm" id="unit-clinic">
                    {clinicName(form.clinicTenantId)}
                  </p>
                )}
                <span className="text-xs text-muted-foreground">{t("unitForm:clinicHint")}</span>
              </div>

              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="unit-establishment-type">
                  {t("unitForm:establishmentTypeLabel")}
                </RequiredLabel>
                <Select
                  value={form.establishmentType || undefined}
                  onValueChange={(value) => update("establishmentType", value as EstablishmentType)}
                  disabled={readOnly}
                >
                  <SelectTrigger id="unit-establishment-type" className="w-full" aria-describedby="unit-establishment-type-hint">
                    <SelectValue placeholder={t("unitForm:establishmentTypePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {ESTABLISHMENT_TYPE_ORDER.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(ESTABLISHMENT_TYPE_LABEL_KEY[type])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground" id="unit-establishment-type-hint">
                  {t("unitForm:establishmentTypeHint")}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <strong className="text-sm">{t("unitForm:operationalLabel")}</strong>
                <p className="mt-1 max-w-[60ch] text-xs text-muted-foreground">{t("unitForm:operationalHint")}</p>
              </div>
              <Label className="flex items-center gap-2.5 font-semibold">
                <Switch checked={form.active} onCheckedChange={(checked) => update("active", checked)} disabled={readOnly} />
                {form.active ? t("unitForm:operationalOn") : t("unitForm:operationalOff")}
              </Label>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4 py-0">
          <SectionHeader step="02" title={t("unitForm:sectionAddress")} />
          <CardContent className="grid gap-3.5 py-5">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <Label htmlFor="unit-cnes">{t("unitForm:cnesLabel")}</Label>
                <Input
                  id="unit-cnes"
                  value={form.cnesCode}
                  placeholder={t("unitForm:cnesPlaceholder")}
                  onChange={(e) => update("cnesCode", e.target.value)}
                  disabled={readOnly}
                  aria-describedby="unit-cnes-hint"
                />
                <span className="text-xs text-muted-foreground" id="unit-cnes-hint">
                  {t("unitForm:cnesHint")}
                </span>
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <Label htmlFor="unit-phone">{t("unitForm:phoneLabel")}</Label>
                <Input
                  id="unit-phone"
                  value={form.phone}
                  placeholder={t("unitForm:phonePlaceholder")}
                  onChange={(e) => update("phone", e.target.value)}
                  disabled={readOnly}
                />
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <Label htmlFor="unit-technical-email">{t("unitForm:technicalEmailLabel")}</Label>
                <Input
                  id="unit-technical-email"
                  type="email"
                  value={form.technicalEmail}
                  placeholder={t("unitForm:technicalEmailPlaceholder")}
                  onChange={(e) => update("technicalEmail", e.target.value)}
                  disabled={readOnly}
                />
              </div>
            </div>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="unit-zip">
                  {t("unitForm:zipCodeLabel")}
                </RequiredLabel>
                <Input
                  id="unit-zip"
                  value={form.zipCode}
                  placeholder={t("unitForm:zipCodePlaceholder")}
                  onChange={(e) => update("zipCode", e.target.value)}
                  required
                  disabled={readOnly}
                  aria-describedby="unit-zip-hint"
                />
                <span className="text-xs text-muted-foreground" id="unit-zip-hint">
                  {t("unitForm:zipCodeHint")}
                </span>
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="unit-street">
                  {t("unitForm:streetLabel")}
                </RequiredLabel>
                <Input
                  id="unit-street"
                  value={form.street}
                  placeholder={t("unitForm:streetPlaceholder")}
                  onChange={(e) => update("street", e.target.value)}
                  required
                  disabled={readOnly}
                />
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="unit-number">
                  {t("unitForm:numberLabel")}
                </RequiredLabel>
                <Input
                  id="unit-number"
                  value={form.number}
                  placeholder={t("unitForm:numberPlaceholder")}
                  onChange={(e) => update("number", e.target.value)}
                  required
                  disabled={readOnly}
                />
              </div>
            </div>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <Label htmlFor="unit-complement">{t("unitForm:complementLabel")}</Label>
                <Input
                  id="unit-complement"
                  value={form.complement}
                  placeholder={t("unitForm:complementPlaceholder")}
                  onChange={(e) => update("complement", e.target.value)}
                  disabled={readOnly}
                />
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="unit-district">
                  {t("unitForm:districtLabel")}
                </RequiredLabel>
                <Input
                  id="unit-district"
                  value={form.district}
                  placeholder={t("unitForm:districtPlaceholder")}
                  onChange={(e) => update("district", e.target.value)}
                  required
                  disabled={readOnly}
                />
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="unit-city">
                  {t("unitForm:cityLabel")}
                </RequiredLabel>
                <Input
                  id="unit-city"
                  value={form.city}
                  placeholder={t("unitForm:cityPlaceholder")}
                  onChange={(e) => update("city", e.target.value)}
                  required
                  disabled={readOnly}
                />
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="unit-state">
                  {t("unitForm:stateLabel")}
                </RequiredLabel>
                <Select value={form.state || undefined} onValueChange={(value) => update("state", value)} disabled={readOnly}>
                  <SelectTrigger id="unit-state" className="w-full">
                    <SelectValue placeholder={t("unitForm:statePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {BR_STATES.map((state) => (
                      <SelectItem key={state} value={state}>
                        {state}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4 py-0">
          <SectionHeader step="03" title={t("unitForm:sectionModality")} />
          <CardContent className="grid gap-3.5 py-5">
            <CheckboxCardGroup
              name="declaredModalities"
              legend={t("unitForm:modalityLabel")}
              options={modalityOptions}
              value={form.declaredModalities}
              onChange={(value) => update("declaredModalities", value)}
              required={!readOnly}
              disabled={readOnly}
              requiredError={t("unitForm:modalityRequiredError")}
            />
            {fieldErrors.declaredModalities && (
              <p className="text-sm text-destructive" role="alert">
                {fieldErrors.declaredModalities}
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <RequiredLabel required={mode === "create"} htmlFor="unit-technical-manager">
                {t("unitForm:technicalManagerLabel")}
              </RequiredLabel>
              <Select
                value={form.technicalManagerId || (mode !== "create" ? MANAGER_UNASSIGNED : undefined)}
                onValueChange={(value) => update("technicalManagerId", value === MANAGER_UNASSIGNED ? "" : value)}
                disabled={readOnly}
              >
                <SelectTrigger
                  id="unit-technical-manager"
                  className="w-full"
                  aria-describedby="unit-technical-manager-hint"
                  aria-invalid={fieldErrors.technicalManagerId ? true : undefined}
                >
                  <SelectValue placeholder={t("unitForm:technicalManagerPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {mode !== "create" && <SelectItem value={MANAGER_UNASSIGNED}>{t("unitForm:technicalManagerUnassign")}</SelectItem>}
                  {managerOptionsForSelect.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground" id="unit-technical-manager-hint">
                {t("unitForm:technicalManagerHint")}
              </span>
              {fieldErrors.technicalManagerId && (
                <p className="text-sm text-destructive" role="alert">
                  {fieldErrors.technicalManagerId}
                </p>
              )}
              {technicalManagerLoadError && (
                <p className="text-sm text-destructive" role="alert">
                  {technicalManagerLoadError}
                </p>
              )}
              {/* Plain recorded text, deliberately with no verification badge -- see this
                  namespace's own docstring on the mock's fabricated "CREDENCIAÇÃO CFM OK". */}
              {selectedManager && (
                <p className="text-xs text-muted-foreground">
                  {t("unitForm:professionalRegistration", {
                    value: selectedManager.professionalRegistration ?? t("adminUnits:notRecorded"),
                  })}
                </p>
              )}
              {!form.technicalManagerId && mode !== "create" && <p className="text-xs text-muted-foreground">{t("unitForm:technicalManagerNone")}</p>}
            </div>
          </CardContent>
        </Card>

        {saveError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap justify-end gap-2.5">
          <Button variant="secondary" asChild>
            <Link to="/admin/units">{readOnly ? t("unitForm:backToList") : t("unitForm:cancel")}</Link>
          </Button>
          {!readOnly && (
            <Button type="submit" disabled={saving}>
              {saving ? t("unitForm:saving") : t("unitForm:save")}
            </Button>
          )}
        </div>
      </form>
    </ConsoleShell>
  );
}
