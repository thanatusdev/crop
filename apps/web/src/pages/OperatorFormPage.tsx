import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { formatCnpj, type TenantDto } from "@crop/shared";
import { api, ApiError } from "../lib/api-client.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Card, CardContent } from "../components/ui/card.js";
import { AddressFormFields, FormSectionHeader, RequiredLabel } from "../components/TenantFormFields.js";

type Mode = "create" | "edit" | "view";

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
  };
}

function formFrom(operator: TenantDto): FormState {
  return {
    name: operator.name,
    cnpj: operator.cnpj ?? "",
    institutionalEmail: operator.institutionalEmail ?? "",
    phone: operator.phone ?? "",
    zipCode: operator.zipCode ?? "",
    street: operator.street ?? "",
    number: operator.number ?? "",
    complement: operator.complement ?? "",
    district: operator.district ?? "",
    city: operator.city ?? "",
    state: operator.state ?? "",
  };
}

/**
 * Register / edit / view one operadora, on its own route -- the `OPERATOR_PROVIDER`
 * counterpart to `ClinicFormPage`, same "three modes, one component" shape and the same
 * institutional/address field set (`CreateTenantRequestSchema`/`UpdateTenantRequestSchema`
 * require the identical set for either tenant type -- see that schema's own docstring).
 *
 * Two things `ClinicFormPage` has that this page deliberately does not:
 *
 * - **No "Responsável" section.** An operadora's accountable person would be an
 *   `OPERATOR_ADMIN` (`responsibleManagerRoleFor(OPERATOR_PROVIDER)`), and the backend
 *   query/validator both already support it (`GET /tenants/responsible-manager-options`),
 *   but there is no "Gestores & Usuários"-equivalent operator-side screen yet for the
 *   create-time note to point at, and no mock/product ask for this field on the operator
 *   side specifically -- left for a follow-up rather than built speculatively.
 * - **`cnpj` editable only on create**, same as `ClinicFormPage` and for the identical
 *   reason: `UpdateTenantRequestSchema` has no `cnpj` field at all.
 */
export default function OperatorFormPage() {
  const { t } = useTranslation(["operatorForm", "adminOperators", "clinicForm"]);
  const navigate = useNavigate();
  const { id, mode: routeMode } = useParams<{ id?: string; mode?: string }>();

  const mode: Mode = !id ? "create" : routeMode === "edit" ? "edit" : "view";
  const readOnly = mode === "view";

  const [form, setForm] = useState<FormState>(emptyForm());

  const [loading, setLoading] = useState(mode !== "create");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    void load();
  }, [id, mode]);

  async function load() {
    setLoadError(null);
    try {
      if (id) {
        setLoading(true);
        const operator = await api.get<TenantDto>(`/tenants/${id}`);
        setForm(formFrom(operator));
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t("operatorForm:loadError"));
    } finally {
      setLoading(false);
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

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
          type: "OPERATOR_PROVIDER",
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
        navigate("/superadmin/operadoras");
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
      });
      navigate("/superadmin/operadoras");
    } catch (err) {
      if (err instanceof ApiError) applyServerFieldErrors(err);
      setSaveError(err instanceof ApiError ? err.message : t("operatorForm:genericSaveError"));
    } finally {
      setSaving(false);
    }
  }

  const title = mode === "create" ? t("operatorForm:createTitle") : mode === "edit" ? t("operatorForm:editTitle") : t("operatorForm:viewTitle");
  const subtitle =
    mode === "create" ? t("operatorForm:createSubtitle") : mode === "edit" ? t("operatorForm:editSubtitle") : t("operatorForm:viewSubtitle");
  const breadcrumbLeaf =
    mode === "create" ? t("operatorForm:breadcrumbNew") : mode === "edit" ? t("operatorForm:breadcrumbEdit") : t("operatorForm:breadcrumbView");

  if (loading) {
    return (
      <ConsoleShell activeNav="operators" pageTitle={title}>
        <p aria-live="polite">{t("operatorForm:loading")}</p>
      </ConsoleShell>
    );
  }

  if (loadError) {
    return (
      <ConsoleShell activeNav="operators" pageTitle={title}>
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <Button variant="secondary" className="mt-3" asChild>
          <Link to="/superadmin/operadoras">{t("operatorForm:backToList")}</Link>
        </Button>
      </ConsoleShell>
    );
  }

  return (
    <ConsoleShell activeNav="operators" pageTitle={title}>
      <nav className="mb-2.5 text-[13px] text-muted-foreground" aria-label={breadcrumbLeaf}>
        <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          <li>{t("operatorForm:breadcrumbHome")}</li>
          <li>
            <span aria-hidden="true">›</span>{" "}
            <Link className="text-primary underline" to="/superadmin/operadoras">
              {t("operatorForm:breadcrumbList")}
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
            <Link to={`/superadmin/operadoras/${id}/edit`}>{t("operatorForm:editThis")}</Link>
          </Button>
        ) : (
          <span className="text-[13px] text-muted-foreground">{t("operatorForm:requiredLegend")}</span>
        )}
      </div>

      <form onSubmit={submit}>
        <Card className="mb-4 py-0">
          <FormSectionHeader step="01" title={t("operatorForm:sectionInstitutional")} />
          <CardContent className="grid gap-3.5 py-5">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="operator-name">
                  {t("operatorForm:nameLabel")}
                </RequiredLabel>
                <Input
                  id="operator-name"
                  value={form.name}
                  placeholder={t("operatorForm:namePlaceholder")}
                  onChange={(e) => update("name", e.target.value)}
                  required
                  disabled={readOnly}
                  aria-describedby="operator-name-hint"
                />
                <span className="text-xs text-muted-foreground" id="operator-name-hint">
                  {t("operatorForm:nameHint")}
                </span>
              </div>

              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={mode === "create"} htmlFor="operator-cnpj">
                  {t("clinicForm:cnpjLabel")}
                </RequiredLabel>
                {mode === "create" ? (
                  <Input
                    id="operator-cnpj"
                    value={form.cnpj}
                    placeholder={t("clinicForm:cnpjPlaceholder")}
                    onChange={(e) => update("cnpj", e.target.value)}
                    required
                    aria-describedby="operator-cnpj-hint"
                    aria-invalid={fieldErrors.cnpj ? true : undefined}
                  />
                ) : (
                  <p className="min-h-6 py-2.5 text-sm" id="operator-cnpj">
                    {form.cnpj ? formatCnpj(form.cnpj) : t("adminOperators:notRecorded")}
                  </p>
                )}
                <span className="text-xs text-muted-foreground" id="operator-cnpj-hint">
                  {t("clinicForm:cnpjHint")}
                </span>
                {fieldErrors.cnpj && (
                  <p className="text-sm text-destructive" role="alert">
                    {fieldErrors.cnpj}
                  </p>
                )}
              </div>

              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="operator-email">
                  {t("operatorForm:institutionalEmailLabel")}
                </RequiredLabel>
                <Input
                  id="operator-email"
                  type="email"
                  value={form.institutionalEmail}
                  placeholder={t("operatorForm:institutionalEmailPlaceholder")}
                  onChange={(e) => update("institutionalEmail", e.target.value)}
                  required
                  disabled={readOnly}
                  aria-describedby="operator-email-hint"
                />
                <span className="text-xs text-muted-foreground" id="operator-email-hint">
                  {t("operatorForm:institutionalEmailHint")}
                </span>
              </div>

              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="operator-phone">
                  {t("clinicForm:phoneLabel")}
                </RequiredLabel>
                <Input
                  id="operator-phone"
                  value={form.phone}
                  placeholder={t("clinicForm:phonePlaceholder")}
                  onChange={(e) => update("phone", e.target.value)}
                  required
                  disabled={readOnly}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4 py-0">
          <FormSectionHeader step="02" title={t("clinicForm:sectionAddress")} />
          <CardContent className="grid gap-3.5 py-5">
            <AddressFormFields
              idPrefix="operator"
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

        {saveError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap justify-end gap-2.5">
          <Button variant="secondary" asChild>
            <Link to="/superadmin/operadoras">{readOnly ? t("operatorForm:backToList") : t("operatorForm:cancel")}</Link>
          </Button>
          {!readOnly && (
            <Button type="submit" disabled={saving}>
              {saving ? t("operatorForm:saving") : t("operatorForm:save")}
            </Button>
          )}
        </div>
      </form>
    </ConsoleShell>
  );
}
