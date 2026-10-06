import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { formatCnpj, type ResponsibleManagerOption, type TenantDto } from "@crop/shared";
import { api, ApiError } from "../lib/api-client.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { AddressFormFields, FormSectionHeader, RequiredLabel } from "../components/TenantFormFields.js";

// Radix `Select.Item` rejects an empty-string `value` -- stands in for "no responsible
// manager assigned," a real, selectable state (edit/view only; a brand-new clinic has no
// section 03 at all -- see this component's own docstring), mapped to/from `""` at the
// read/write boundary below, same convention as `UnitFormPage`'s `MANAGER_UNASSIGNED`.
const MANAGER_UNASSIGNED = "__unassigned__";

type Mode = "create" | "edit" | "view";

/**
 * The subset of `ResponsibleManagerOption` (from `GET /tenants/responsible-manager-options`)
 * this form actually renders -- the same narrowing `UnitFormPage`'s own `ManagerOption`
 * applies to `TechnicalManagerOption`, and for the identical reason: `TenantDto.responsibleManager`
 * (what a *loaded* clinic denormalizes about its own chosen manager) carries only these two
 * fields, no `email`/`role`, so this is the shape both the candidates list and the loaded
 * value can share without fabricating values the loaded clinic doesn't have.
 */
type ManagerOption = Pick<ResponsibleManagerOption, "id" | "name" | "professionalRegistration">;

interface FormState {
  name: string;
  cnpj: string;
  institutionalEmail: string;
  phone: string;
  zipCode: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  responsibleManagerId: string;
}

function emptyForm(): FormState {
  return {
    name: "",
    cnpj: "",
    institutionalEmail: "",
    phone: "",
    zipCode: "",
    street: "",
    number: "",
    complement: "",
    district: "",
    city: "",
    state: "",
    responsibleManagerId: "",
  };
}

function formFrom(clinic: TenantDto): FormState {
  return {
    name: clinic.name,
    cnpj: clinic.cnpj ?? "",
    institutionalEmail: clinic.institutionalEmail ?? "",
    phone: clinic.phone ?? "",
    zipCode: clinic.zipCode ?? "",
    street: clinic.street ?? "",
    number: clinic.number ?? "",
    complement: clinic.complement ?? "",
    district: clinic.district ?? "",
    city: clinic.city ?? "",
    state: clinic.state ?? "",
    responsibleManagerId: clinic.responsibleManagerId ?? "",
  };
}

/**
 * Register / edit / view one clinic, on its own route -- same "three modes, one component"
 * shape as `EquipmentFormPage`/`UnitFormPage`. Two things depart from that shared shape,
 * both deliberate:
 *
 * - **No status toggle.** Unlike the equipment/unit forms, there is no "Ativo/Inativo"
 *   switch here at all -- a clinic is always created active, and deactivation only happens
 *   from the listing's own confirm-dialog action (`POST /tenants/:id/deactivate`), the same
 *   lifecycle-transition-is-a-separate-endpoint reasoning, just with no create-time mirror
 *   of it since the mock never showed one for clinics either.
 * - **Section 03 ("Responsável pela Clínica") only appears in edit/view.** A brand-new
 *   clinic has zero users yet, so there is nothing to pick from and `responsibleManagerId`
 *   isn't even accepted by `CreateTenantRequestSchema` -- the section instead shows a note
 *   pointing at Gestores & Usuários once the clinic exists.
 *
 * `cnpj` is editable only on create: `UpdateTenantRequestSchema` has no `cnpj` field at all
 * (see that schema's own docstring), so edit/view render it as plain read-only text
 * regardless of `readOnly`, the same non-interactive-regardless-of-mode treatment
 * `UnitFormPage` gives its own immutable `clinicTenantId`.
 *
 * Each numbered section is its own `Card`, same "shared ancestor" reasoning as
 * `EquipmentFormPage`'s own docstring -- see docs/architecture.md's shadcn migration entries.
 */
export default function ClinicFormPage() {
  const { t } = useTranslation(["clinicForm", "adminClinics"]);
  const navigate = useNavigate();
  const { id, mode: routeMode } = useParams<{ id?: string; mode?: string }>();

  const mode: Mode = !id ? "create" : routeMode === "edit" ? "edit" : "view";
  const readOnly = mode === "view";

  const [form, setForm] = useState<FormState>(emptyForm());
  const [loadedClinic, setLoadedClinic] = useState<TenantDto | null>(null);

  const [managerOptions, setManagerOptions] = useState<ManagerOption[]>([]);
  const [managerLoadError, setManagerLoadError] = useState<string | null>(null);
  // The clinic's own denormalized manager, captured at load time -- guarantees the select
  // always has a matching <option> even if that person has since become ineligible (role
  // changed, locked, or left the clinic) and so no longer appears in `managerOptions`. Same
  // pattern as UnitFormPage's `loadedManager`.
  const [loadedManager, setLoadedManager] = useState<ManagerOption | null>(null);

  const [loading, setLoading] = useState(mode !== "create");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    void load();
  }, [id, mode]);

  useEffect(() => {
    if (id) void loadManagers(id);
  }, [id]);

  async function load() {
    setLoadError(null);
    try {
      if (id) {
        setLoading(true);
        const clinic = await api.get<TenantDto>(`/tenants/${id}`);
        setForm(formFrom(clinic));
        setLoadedClinic(clinic);
        setLoadedManager(clinic.responsibleManager);
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t("clinicForm:loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function loadManagers(clinicTenantId: string) {
    setManagerLoadError(null);
    try {
      setManagerOptions(await api.get<ManagerOption[]>(`/tenants/responsible-manager-options?tenantId=${clinicTenantId}`));
    } catch {
      setManagerLoadError(t("clinicForm:managerLoadError"));
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const managerOptionsForSelect = useMemo(() => {
    if (loadedManager && !managerOptions.some((option) => option.id === loadedManager.id)) {
      return [loadedManager, ...managerOptions];
    }
    return managerOptions;
  }, [managerOptions, loadedManager]);
  const selectedManager = managerOptionsForSelect.find((option) => option.id === form.responsibleManagerId);

  function applyServerFieldErrors(err: ApiError) {
    const mapped: Record<string, string> = {};
    for (const issue of err.fieldErrors) {
      if (issue.path) mapped[issue.path] = issue.message;
    }
    setFieldErrors(mapped);
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setSaveError(null);
    setFieldErrors({});

    setSaving(true);
    try {
      if (mode === "create") {
        await api.post<TenantDto>("/tenants", {
          name: form.name,
          type: "CLINIC",
          cnpj: form.cnpj,
          institutionalEmail: form.institutionalEmail,
          phone: form.phone,
          zipCode: form.zipCode,
          street: form.street,
          number: form.number,
          complement: form.complement || null,
          district: form.district,
          city: form.city,
          state: form.state,
        });
        navigate("/superadmin/clinics");
        return;
      }

      await api.patch(`/tenants/${id}`, {
        name: form.name,
        institutionalEmail: form.institutionalEmail,
        phone: form.phone,
        zipCode: form.zipCode,
        street: form.street,
        number: form.number,
        complement: form.complement || null,
        district: form.district,
        city: form.city,
        state: form.state,
        responsibleManagerId: form.responsibleManagerId || null,
      });
      navigate("/superadmin/clinics");
    } catch (err) {
      if (err instanceof ApiError) applyServerFieldErrors(err);
      setSaveError(err instanceof ApiError ? err.message : t("clinicForm:genericSaveError"));
    } finally {
      setSaving(false);
    }
  }

  const title = mode === "create" ? t("clinicForm:createTitle") : mode === "edit" ? t("clinicForm:editTitle") : t("clinicForm:viewTitle");
  const subtitle =
    mode === "create" ? t("clinicForm:createSubtitle") : mode === "edit" ? t("clinicForm:editSubtitle") : t("clinicForm:viewSubtitle");
  const breadcrumbLeaf =
    mode === "create" ? t("clinicForm:breadcrumbNew") : mode === "edit" ? t("clinicForm:breadcrumbEdit") : t("clinicForm:breadcrumbView");

  if (loading) {
    return (
      <ConsoleShell activeNav="clinics" pageTitle={title}>
        <p aria-live="polite">{t("clinicForm:loading")}</p>
      </ConsoleShell>
    );
  }

  if (loadError) {
    return (
      <ConsoleShell activeNav="clinics" pageTitle={title}>
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <Button variant="secondary" className="mt-3" asChild>
          <Link to="/superadmin/clinics">{t("clinicForm:backToList")}</Link>
        </Button>
      </ConsoleShell>
    );
  }

  return (
    <ConsoleShell activeNav="clinics" pageTitle={title}>
      <nav className="mb-2.5 text-[13px] text-muted-foreground" aria-label={breadcrumbLeaf}>
        <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          <li>{t("clinicForm:breadcrumbHome")}</li>
          <li>
            <span aria-hidden="true">›</span>{" "}
            <Link className="text-primary underline" to="/superadmin/clinics">
              {t("clinicForm:breadcrumbList")}
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
            <Link to={`/superadmin/clinics/${id}/edit`}>{t("clinicForm:editThis")}</Link>
          </Button>
        ) : (
          <span className="text-[13px] text-muted-foreground">{t("clinicForm:requiredLegend")}</span>
        )}
      </div>

      <form onSubmit={submit}>
        <Card className="mb-4 py-0">
          <FormSectionHeader step="01" title={t("clinicForm:sectionInstitutional")} />
          <CardContent className="grid gap-3.5 py-5">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="clinic-name">
                  {t("clinicForm:nameLabel")}
                </RequiredLabel>
                <Input
                  id="clinic-name"
                  value={form.name}
                  placeholder={t("clinicForm:namePlaceholder")}
                  onChange={(e) => update("name", e.target.value)}
                  required
                  disabled={readOnly}
                  aria-describedby="clinic-name-hint"
                />
                <span className="text-xs text-muted-foreground" id="clinic-name-hint">
                  {t("clinicForm:nameHint")}
                </span>
              </div>

              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={mode === "create"} htmlFor="clinic-cnpj">
                  {t("clinicForm:cnpjLabel")}
                </RequiredLabel>
                {mode === "create" ? (
                  <Input
                    id="clinic-cnpj"
                    value={form.cnpj}
                    placeholder={t("clinicForm:cnpjPlaceholder")}
                    onChange={(e) => update("cnpj", e.target.value)}
                    required
                    aria-describedby="clinic-cnpj-hint"
                    aria-invalid={fieldErrors.cnpj ? true : undefined}
                  />
                ) : (
                  <p className="min-h-6 py-2.5 text-sm" id="clinic-cnpj">
                    {form.cnpj ? formatCnpj(form.cnpj) : t("adminClinics:notRecorded")}
                  </p>
                )}
                <span className="text-xs text-muted-foreground" id="clinic-cnpj-hint">
                  {t("clinicForm:cnpjHint")}
                </span>
                {fieldErrors.cnpj && (
                  <p className="text-sm text-destructive" role="alert">
                    {fieldErrors.cnpj}
                  </p>
                )}
              </div>

              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="clinic-email">
                  {t("clinicForm:institutionalEmailLabel")}
                </RequiredLabel>
                <Input
                  id="clinic-email"
                  type="email"
                  value={form.institutionalEmail}
                  placeholder={t("clinicForm:institutionalEmailPlaceholder")}
                  onChange={(e) => update("institutionalEmail", e.target.value)}
                  required
                  disabled={readOnly}
                  aria-describedby="clinic-email-hint"
                />
                <span className="text-xs text-muted-foreground" id="clinic-email-hint">
                  {t("clinicForm:institutionalEmailHint")}
                </span>
              </div>

              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="clinic-phone">
                  {t("clinicForm:phoneLabel")}
                </RequiredLabel>
                <Input
                  id="clinic-phone"
                  value={form.phone}
                  placeholder={t("clinicForm:phonePlaceholder")}
                  onChange={(e) => update("phone", e.target.value)}
                  required
                  disabled={readOnly}
                />
              </div>
            </div>

            {loadedClinic && loadedClinic.isMatriz !== null && (
              <div className="flex flex-col gap-1.5">
                <Label>{t("clinicForm:branchLabel")}</Label>
                <p className="min-h-6 py-2.5 text-sm">{loadedClinic.isMatriz ? t("clinicForm:branchMatriz") : t("clinicForm:branchFilial")}</p>
                <span className="text-xs text-muted-foreground">{t("clinicForm:branchDerivedNote")}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mb-4 py-0">
          <FormSectionHeader step="02" title={t("clinicForm:sectionAddress")} />
          <CardContent className="grid gap-3.5 py-5">
            <AddressFormFields
              idPrefix="clinic"
              values={form}
              onChange={update}
              readOnly={readOnly}
              labels={{
                zipCodeLabel: t("clinicForm:zipCodeLabel"),
                zipCodePlaceholder: t("clinicForm:zipCodePlaceholder"),
                zipCodeHint: t("clinicForm:zipCodeHint"),
                streetLabel: t("clinicForm:streetLabel"),
                streetPlaceholder: t("clinicForm:streetPlaceholder"),
                numberLabel: t("clinicForm:numberLabel"),
                numberPlaceholder: t("clinicForm:numberPlaceholder"),
                complementLabel: t("clinicForm:complementLabel"),
                complementPlaceholder: t("clinicForm:complementPlaceholder"),
                districtLabel: t("clinicForm:districtLabel"),
                districtPlaceholder: t("clinicForm:districtPlaceholder"),
                cityLabel: t("clinicForm:cityLabel"),
                cityPlaceholder: t("clinicForm:cityPlaceholder"),
                stateLabel: t("clinicForm:stateLabel"),
                statePlaceholder: t("clinicForm:statePlaceholder"),
              }}
            />
          </CardContent>
        </Card>

        {mode !== "create" && (
          <Card className="mb-4 py-0">
            <FormSectionHeader step="03" title={t("clinicForm:sectionManager")} />
            <CardContent className="grid gap-3.5 py-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="clinic-manager">{t("clinicForm:managerLabel")}</Label>
                <Select
                  value={form.responsibleManagerId || MANAGER_UNASSIGNED}
                  onValueChange={(value) => update("responsibleManagerId", value === MANAGER_UNASSIGNED ? "" : value)}
                  disabled={readOnly}
                >
                  <SelectTrigger id="clinic-manager" className="w-full" aria-describedby="clinic-manager-hint">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={MANAGER_UNASSIGNED}>{t("clinicForm:managerUnassign")}</SelectItem>
                    {managerOptionsForSelect.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground" id="clinic-manager-hint">
                  {t("clinicForm:managerHint")}
                </span>
                {managerLoadError && (
                  <p className="text-sm text-destructive" role="alert">
                    {managerLoadError}
                  </p>
                )}
                {/* Plain recorded text, deliberately with no CFM/SBIS verification badge --
                    see this namespace's own docstring on why that mock element was dropped. */}
                {selectedManager && (
                  <p className="text-xs text-muted-foreground">
                    {t("clinicForm:professionalRegistration", {
                      value: selectedManager.professionalRegistration ?? t("adminClinics:notRecorded"),
                    })}
                  </p>
                )}
                {!form.responsibleManagerId && <p className="text-xs text-muted-foreground">{t("clinicForm:managerNone")}</p>}
              </div>
            </CardContent>
          </Card>
        )}

        {mode === "create" && (
          <Card className="mb-4 py-0">
            <FormSectionHeader step="03" title={t("clinicForm:sectionManager")} />
            <CardContent className="py-5">
              <p className="text-sm text-muted-foreground">{t("clinicForm:managerCreateNote")}</p>
            </CardContent>
          </Card>
        )}

        {saveError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap justify-end gap-2.5">
          <Button variant="secondary" asChild>
            <Link to="/superadmin/clinics">{readOnly ? t("clinicForm:backToList") : t("clinicForm:cancel")}</Link>
          </Button>
          {!readOnly && (
            <Button type="submit" disabled={saving}>
              {saving ? t("clinicForm:saving") : t("clinicForm:save")}
            </Button>
          )}
        </div>
      </form>
    </ConsoleShell>
  );
}
