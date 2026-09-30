import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_KEYMAP,
  ExamModality,
  PIKVM_KEYMAPS,
  TargetOs,
  type EquipmentDto,
  type UnitDto,
} from "@crop/shared";
import { api, ApiError } from "../lib/api-client.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { RadioCardGroup, type RadioCardOption } from "../components/RadioCardGroup.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Switch } from "../components/ui/switch.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { MODALITY_HINT_KEY, MODALITY_LABEL_KEY, MODALITY_ORDER, toDateInputValue } from "../lib/equipment-display.js";

const TARGET_OS_OPTIONS: readonly TargetOs[] = [TargetOs.WINDOWS, TargetOs.MACOS, TargetOs.LINUX];

// Radix `Select.Item` rejects an empty-string `value` -- this stands in for "no unit chosen,
// assign automatically" (a real, meaningful state; not a filter) and is mapped to/from `""`
// at the read/write boundary below, same convention as `UNSET`/`ALL` on the other admin pages.
const UNIT_AUTO = "__auto__";

type Mode = "create" | "edit" | "view";

interface FormState {
  name: string;
  brand: string;
  model: string;
  serialNumber: string;
  roomLabel: string;
  unitId: string;
  installedAt: string;
  active: boolean;
  modality: ExamModality | null;
  aeTitle: string;
  dicomIp: string;
  dicomPort: string;
  pikvmHost: string;
  pikvmUser: string;
  pikvmPassword: string;
  targetOs: TargetOs;
  keymap: string;
  screenWidth: string;
  screenHeight: string;
  cameraUrl: string;
}

function emptyForm(): FormState {
  return {
    name: "",
    brand: "",
    model: "",
    serialNumber: "",
    roomLabel: "",
    unitId: "",
    installedAt: "",
    active: true,
    modality: null,
    aeTitle: "",
    dicomIp: "",
    dicomPort: "",
    pikvmHost: "",
    pikvmUser: "admin",
    pikvmPassword: "",
    targetOs: TargetOs.WINDOWS,
    keymap: DEFAULT_KEYMAP,
    screenWidth: "1920",
    screenHeight: "1080",
    cameraUrl: "",
  };
}

function formFrom(equipment: EquipmentDto): FormState {
  return {
    name: equipment.name,
    brand: equipment.brand ?? "",
    model: equipment.model ?? "",
    serialNumber: equipment.serialNumber ?? "",
    roomLabel: equipment.roomLabel ?? "",
    unitId: equipment.unitId ?? "",
    installedAt: toDateInputValue(equipment.installedAt),
    active: !equipment.deactivated,
    modality: equipment.modality,
    aeTitle: equipment.aeTitle ?? "",
    dicomIp: equipment.dicomIp ?? "",
    dicomPort: equipment.dicomPort === null ? "" : String(equipment.dicomPort),
    pikvmHost: equipment.pikvmHost,
    pikvmUser: equipment.pikvmUser,
    // Always blank: the API never returns the stored PiKVM password (by design -- see
    // EquipmentSchema), and blank on submit means "leave it unchanged."
    pikvmPassword: "",
    targetOs: equipment.targetOs,
    keymap: equipment.keymap,
    screenWidth: String(equipment.screenWidth),
    screenHeight: String(equipment.screenHeight),
    cameraUrl: equipment.cameraUrl ?? "",
  };
}

/**
 * Register / edit / view one piece of equipment, on its own route rather than as a form inline
 * above the listing table (which is what every other admin page in this app does). The field
 * count is why: four sections and eighteen fields sitting permanently above a paginated table
 * would bury the table, and the mock this is built from shows a dedicated page too.
 *
 * Three modes share one component because the read-only view is the same layout with inputs
 * disabled -- splitting it into a second component would duplicate every label and section for
 * the sake of rendering the same values without a border.
 *
 * The "Conexão de Teleoperação" section has no counterpart in the mock, which showed only the
 * DICOM fields. It is here because it is the part that actually does something: a scanner
 * registered without PiKVM credentials cannot be operated by this platform at all, which is
 * the platform's entire purpose. The DICOM fields directly above it, by contrast, are recorded
 * and never used, and the section note says so rather than letting the two look equivalent.
 *
 * Each numbered section is its own `Card` -- not a stylistic choice so much as what the
 * "shared ancestor" rule (see docs/architecture.md's shadcn migration entries) requires: a
 * `Card` is a claimed light background, so everything inside it may use Tailwind's semantic
 * text colors directly. `ConsoleShell`'s own `<main>` claims one too now that every page it
 * renders is migrated, so the breadcrumb/heading/required-legend above the form use
 * `text-muted-foreground`/`text-primary` directly as well, the same as everything else here.
 */
/**
 * A field label carrying the required marker. Defined at module scope, not inside
 * `EquipmentFormPage` -- a component declared in a render body is a brand-new component type
 * on every render, which makes React unmount and remount its entire subtree each keystroke
 * instead of updating it.
 *
 * The asterisk is `aria-hidden`: the input's own `required` attribute is what conveys this to
 * assistive tech, so announcing "asterisk" on top of "required" would just be noise.
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

export default function EquipmentFormPage() {
  const { t } = useTranslation(["equipmentForm", "adminEquipment"]);
  const navigate = useNavigate();
  const { id, mode: routeMode } = useParams<{ id?: string; mode?: string }>();

  const mode: Mode = !id ? "create" : routeMode === "edit" ? "edit" : "view";
  const readOnly = mode === "view";

  const [form, setForm] = useState<FormState>(emptyForm());
  const [units, setUnits] = useState<UnitDto[]>([]);
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
      const unitList = await api.get<UnitDto[]>("/units").catch(() => [] as UnitDto[]);
      setUnits(unitList);
      if (id) {
        setLoading(true);
        setForm(formFrom(await api.get<EquipmentDto>(`/equipment/${id}`)));
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t("equipmentForm:loadError"));
    } finally {
      setLoading(false);
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const modalityOptions: readonly RadioCardOption<ExamModality>[] = useMemo(
    () =>
      MODALITY_ORDER.map((modality) => ({
        value: modality,
        title: t(MODALITY_LABEL_KEY[modality]),
        hint: t(MODALITY_HINT_KEY[modality]),
      })),
    [t]
  );

  /**
   * Maps the API's Zod field errors back onto the inputs that produced them.
   *
   * `ZodValidationPipe` answers a 400 with `{path, message}[]`, which `ApiError.fieldErrors`
   * now preserves -- so a server-side rejection highlights the offending input instead of only
   * appearing as one sentence at the bottom of a four-section form. The client-side checks in
   * `validate()` below stay deliberately few: re-implementing the whole schema here would just
   * create a second validator to drift out of step with the real one.
   */
  function applyServerFieldErrors(err: ApiError) {
    const mapped: Record<string, string> = {};
    for (const issue of err.fieldErrors) {
      if (issue.path) mapped[issue.path] = issue.message;
    }
    setFieldErrors(mapped);
  }

  function validate(): boolean {
    const errors: Record<string, string> = {};
    if (!form.modality) errors.modality = t("equipmentForm:validationSummary");
    // Mirrors AeTitleSchema. Checked here purely so the operator sees it next to the field
    // instead of after a round trip; the server remains the enforcing side.
    if (form.aeTitle && !/^[A-Z0-9_-]{1,16}$/.test(form.aeTitle)) errors.aeTitle = t("equipmentForm:aeTitleHint");
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
        modality: form.modality,
        brand: form.brand,
        model: form.model,
        serialNumber: form.serialNumber,
        roomLabel: form.roomLabel,
        installedAt: form.installedAt,
        // `null` rather than omitted on update, so clearing a DICOM field actually clears it
        // (the update schema allows null for exactly these three; omitting would mean
        // "unchanged"). On create the API normalizes null the same way.
        aeTitle: form.aeTitle || null,
        dicomIp: form.dicomIp || null,
        dicomPort: form.dicomPort ? Number(form.dicomPort) : null,
        pikvmHost: form.pikvmHost,
        pikvmUser: form.pikvmUser,
        targetOs: form.targetOs,
        keymap: form.keymap,
        screenWidth: Number(form.screenWidth),
        screenHeight: Number(form.screenHeight),
        cameraUrl: form.cameraUrl || null,
      };

      if (mode === "create") {
        const created = await api.post<EquipmentDto>("/equipment", {
          ...shared,
          unitId: form.unitId || undefined,
          pikvmPassword: form.pikvmPassword,
          // The create schema has no notion of an already-retired device, and registering one
          // as immediately out of service makes no sense -- so the toggle only applies the
          // deactivation call below, for the one case where it was switched off up front.
        });
        if (!form.active) await api.post(`/equipment/${created.id}/deactivate`);
        navigate("/admin/equipment");
        return;
      }

      const body: Record<string, unknown> = { ...shared, unitId: form.unitId || null };
      // Blank means "keep the stored credential" -- see UpdateEquipmentRequestSchema.
      if (form.pikvmPassword) body.pikvmPassword = form.pikvmPassword;
      await api.patch(`/equipment/${id}`, body);

      // Deactivation is a separate endpoint, not a PATCH field, because it is a lifecycle
      // transition with its own audit action -- so a toggle change is a second call, made only
      // when the toggle actually moved.
      const current = await api.get<EquipmentDto>(`/equipment/${id}`);
      if (current.deactivated === form.active) {
        await api.post(`/equipment/${id}/${form.active ? "reactivate" : "deactivate"}`);
      }
      navigate("/admin/equipment");
    } catch (err) {
      if (err instanceof ApiError) applyServerFieldErrors(err);
      setSaveError(err instanceof ApiError ? err.message : t("equipmentForm:genericSaveError"));
    } finally {
      setSaving(false);
    }
  }

  const title = mode === "create" ? t("equipmentForm:createTitle") : mode === "edit" ? t("equipmentForm:editTitle") : t("equipmentForm:viewTitle");
  const subtitle =
    mode === "create" ? t("equipmentForm:createSubtitle") : mode === "edit" ? t("equipmentForm:editSubtitle") : t("equipmentForm:viewSubtitle");
  const breadcrumbLeaf =
    mode === "create" ? t("equipmentForm:breadcrumbNew") : mode === "edit" ? t("equipmentForm:breadcrumbEdit") : t("equipmentForm:breadcrumbView");

  if (loading) {
    return (
      <ConsoleShell activeNav="equipment" pageTitle={title}>
        <p aria-live="polite">{t("equipmentForm:loading")}</p>
      </ConsoleShell>
    );
  }

  if (loadError) {
    return (
      <ConsoleShell activeNav="equipment" pageTitle={title}>
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <Button variant="secondary" className="mt-3" asChild>
          <Link to="/admin/equipment">{t("equipmentForm:backToList")}</Link>
        </Button>
      </ConsoleShell>
    );
  }

  return (
    <ConsoleShell activeNav="equipment" pageTitle={title}>
      <nav className="mb-2.5 text-[13px] text-muted-foreground" aria-label={breadcrumbLeaf}>
        <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          <li>{t("equipmentForm:breadcrumbHome")}</li>
          <li>
            <span aria-hidden="true">›</span>{" "}
            <Link className="text-primary underline" to="/admin/equipment">
              {t("equipmentForm:breadcrumbList")}
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
            <Link to={`/admin/equipment/${id}/edit`}>{t("equipmentForm:editThis")}</Link>
          </Button>
        ) : (
          <span className="text-[13px] text-muted-foreground">{t("equipmentForm:requiredLegend")}</span>
        )}
      </div>

      <form onSubmit={submit}>
        <Card className="mb-4 py-0">
          <SectionHeader step="01" title={t("equipmentForm:sectionIdentification")} />
          <CardContent className="grid gap-3.5 py-5">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="eq-name">
                  {t("equipmentForm:nameLabel")}
                </RequiredLabel>
                <Input
                  id="eq-name"
                  value={form.name}
                  placeholder={t("equipmentForm:namePlaceholder")}
                  onChange={(e) => update("name", e.target.value)}
                  required
                  disabled={readOnly}
                  aria-describedby="eq-name-hint"
                />
                <span className="text-xs text-muted-foreground" id="eq-name-hint">
                  {t("equipmentForm:nameHint")}
                </span>
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="eq-brand">
                  {t("equipmentForm:brandLabel")}
                </RequiredLabel>
                <Input
                  id="eq-brand"
                  value={form.brand}
                  placeholder={t("equipmentForm:brandPlaceholder")}
                  onChange={(e) => update("brand", e.target.value)}
                  required
                  disabled={readOnly}
                />
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="eq-model">
                  {t("equipmentForm:modelLabel")}
                </RequiredLabel>
                <Input
                  id="eq-model"
                  value={form.model}
                  placeholder={t("equipmentForm:modelPlaceholder")}
                  onChange={(e) => update("model", e.target.value)}
                  required
                  disabled={readOnly}
                />
              </div>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="eq-serial">
                  {t("equipmentForm:serialLabel")}
                </RequiredLabel>
                <Input
                  id="eq-serial"
                  value={form.serialNumber}
                  placeholder={t("equipmentForm:serialPlaceholder")}
                  onChange={(e) => update("serialNumber", e.target.value)}
                  required
                  disabled={readOnly}
                  aria-describedby="eq-serial-hint"
                />
                <span className="text-xs text-muted-foreground" id="eq-serial-hint">
                  {t("equipmentForm:serialHint")}
                </span>
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="eq-room">
                  {t("equipmentForm:roomLabel")}
                </RequiredLabel>
                <Input
                  id="eq-room"
                  value={form.roomLabel}
                  placeholder={t("equipmentForm:roomPlaceholder")}
                  onChange={(e) => update("roomLabel", e.target.value)}
                  required
                  disabled={readOnly}
                  aria-describedby="eq-room-hint"
                />
                <span className="text-xs text-muted-foreground" id="eq-room-hint">
                  {t("equipmentForm:roomHint")}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4 py-0">
          <SectionHeader step="02" title={t("equipmentForm:sectionLink")} />
          <CardContent className="grid gap-3.5 py-5">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor="eq-unit">{t("equipmentForm:unitLabel")}</Label>
                  {!readOnly && (
                    <Link className="text-sm text-primary underline-offset-2 hover:underline" to="/admin/units">
                      {t("equipmentForm:unitManageLink")}
                    </Link>
                  )}
                </div>
                <Select
                  value={form.unitId || UNIT_AUTO}
                  onValueChange={(value) => update("unitId", value === UNIT_AUTO ? "" : value)}
                  disabled={readOnly}
                >
                  <SelectTrigger id="eq-unit" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNIT_AUTO}>{t("equipmentForm:unitAutomatic")}</SelectItem>
                    {units.map((unit) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {unit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">{t("equipmentForm:unitHint")}</span>
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="eq-installed">
                  {t("equipmentForm:installedAtLabel")}
                </RequiredLabel>
                <Input
                  id="eq-installed"
                  type="date"
                  value={form.installedAt}
                  onChange={(e) => update("installedAt", e.target.value)}
                  required
                  disabled={readOnly}
                  aria-describedby="eq-installed-hint"
                />
                <span className="text-xs text-muted-foreground" id="eq-installed-hint">
                  {t("equipmentForm:installedAtHint")}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <strong className="text-sm">{t("equipmentForm:operationalLabel")}</strong>
                <p className="mt-1 max-w-[60ch] text-xs text-muted-foreground">{t("equipmentForm:operationalHint")}</p>
              </div>
              <Label className="flex items-center gap-2.5 font-semibold">
                <Switch checked={form.active} onCheckedChange={(checked) => update("active", checked)} disabled={readOnly} />
                {form.active ? t("equipmentForm:operationalOn") : t("equipmentForm:operationalOff")}
              </Label>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4 py-0">
          <SectionHeader step="03" title={t("equipmentForm:sectionModality")} />
          <CardContent className="grid gap-3.5 py-5">
            <RadioCardGroup
              name="modality"
              legend={t("equipmentForm:modalityLabel")}
              options={modalityOptions}
              value={form.modality}
              onChange={(value) => update("modality", value)}
              required={!readOnly}
              disabled={readOnly}
            />
            {fieldErrors.modality && (
              <p className="text-sm text-destructive" role="alert">
                {fieldErrors.modality}
              </p>
            )}

            <p className="text-sm text-muted-foreground">{t("equipmentForm:dicomNote")}</p>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <Label htmlFor="eq-ae-title">{t("equipmentForm:aeTitleLabel")}</Label>
                <Input
                  id="eq-ae-title"
                  value={form.aeTitle}
                  placeholder={t("equipmentForm:aeTitlePlaceholder")}
                  // Uppercased as typed, since the schema only accepts uppercase -- less
                  // annoying than rejecting the operator's lowercase input after the fact.
                  onChange={(e) => update("aeTitle", e.target.value.toUpperCase())}
                  maxLength={16}
                  disabled={readOnly}
                  aria-describedby="eq-ae-title-hint"
                  aria-invalid={fieldErrors.aeTitle ? true : undefined}
                />
                <span className="text-xs text-muted-foreground" id="eq-ae-title-hint">
                  {t("equipmentForm:aeTitleHint")}
                </span>
                {fieldErrors.aeTitle && (
                  <p className="text-sm text-destructive" role="alert">
                    {fieldErrors.aeTitle}
                  </p>
                )}
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <Label htmlFor="eq-dicom-ip">{t("equipmentForm:dicomIpLabel")}</Label>
                <Input
                  id="eq-dicom-ip"
                  value={form.dicomIp}
                  placeholder={t("equipmentForm:dicomIpPlaceholder")}
                  onChange={(e) => update("dicomIp", e.target.value)}
                  disabled={readOnly}
                />
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <Label htmlFor="eq-dicom-port">{t("equipmentForm:dicomPortLabel")}</Label>
                <Input
                  id="eq-dicom-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={form.dicomPort}
                  placeholder={t("equipmentForm:dicomPortPlaceholder")}
                  onChange={(e) => update("dicomPort", e.target.value)}
                  disabled={readOnly}
                  aria-invalid={fieldErrors.dicomPort ? true : undefined}
                />
                {fieldErrors.dicomPort && (
                  <p className="text-sm text-destructive" role="alert">
                    {fieldErrors.dicomPort}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4 py-0">
          <SectionHeader step="04" title={t("equipmentForm:sectionTeleoperation")} />
          <CardContent className="grid gap-3.5 py-5">
            <p className="text-sm text-muted-foreground">{t("equipmentForm:teleoperationNote")}</p>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="eq-pikvm-host">
                  {t("equipmentForm:pikvmHostLabel")}
                </RequiredLabel>
                <Input
                  id="eq-pikvm-host"
                  value={form.pikvmHost}
                  placeholder={t("equipmentForm:pikvmHostPlaceholder")}
                  onChange={(e) => update("pikvmHost", e.target.value)}
                  required
                  disabled={readOnly}
                />
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="eq-pikvm-user">
                  {t("equipmentForm:pikvmUserLabel")}
                </RequiredLabel>
                <Input id="eq-pikvm-user" value={form.pikvmUser} onChange={(e) => update("pikvmUser", e.target.value)} required disabled={readOnly} />
              </div>
              {/* Never rendered in view mode at all: there is nothing to show (the API never
                  returns it) and no reason to offer a write-only field on a read-only page. */}
              {!readOnly && (
                <div className="mb-3.5 flex flex-col gap-1.5">
                  {mode === "create" ? (
                    <RequiredLabel required={!readOnly} htmlFor="eq-pikvm-password">
                      {t("equipmentForm:pikvmPasswordLabel")}
                    </RequiredLabel>
                  ) : (
                    <Label htmlFor="eq-pikvm-password">{t("equipmentForm:pikvmPasswordLabel")}</Label>
                  )}
                  <Input
                    id="eq-pikvm-password"
                    type="password"
                    value={form.pikvmPassword}
                    onChange={(e) => update("pikvmPassword", e.target.value)}
                    required={mode === "create"}
                    autoComplete="new-password"
                    aria-describedby={mode === "edit" ? "eq-pikvm-password-hint" : undefined}
                  />
                  {mode === "edit" && (
                    <span className="text-xs text-muted-foreground" id="eq-pikvm-password-hint">
                      {t("equipmentForm:pikvmPasswordEditHint")}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
              <div className="mb-3.5 flex flex-col gap-1.5">
                <Label htmlFor="eq-target-os">{t("equipmentForm:targetOsLabel")}</Label>
                <Select value={form.targetOs} onValueChange={(value) => update("targetOs", value as TargetOs)} disabled={readOnly}>
                  <SelectTrigger id="eq-target-os" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TARGET_OS_OPTIONS.map((os) => (
                      <SelectItem key={os} value={os}>
                        {os}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <Label htmlFor="eq-keymap">{t("equipmentForm:keymapLabel")}</Label>
                <Select value={form.keymap} onValueChange={(value) => update("keymap", value)} disabled={readOnly}>
                  <SelectTrigger id="eq-keymap" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PIKVM_KEYMAPS.map((keymap) => (
                      <SelectItem key={keymap} value={keymap}>
                        {keymap}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <Label htmlFor="eq-screen-width">{t("equipmentForm:screenWidthLabel")}</Label>
                <Input
                  id="eq-screen-width"
                  type="number"
                  min={1}
                  value={form.screenWidth}
                  onChange={(e) => update("screenWidth", e.target.value)}
                  required
                  disabled={readOnly}
                />
              </div>
              <div className="mb-3.5 flex flex-col gap-1.5">
                <Label htmlFor="eq-screen-height">{t("equipmentForm:screenHeightLabel")}</Label>
                <Input
                  id="eq-screen-height"
                  type="number"
                  min={1}
                  value={form.screenHeight}
                  onChange={(e) => update("screenHeight", e.target.value)}
                  required
                  disabled={readOnly}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eq-camera">{t("equipmentForm:cameraUrlLabel")}</Label>
              <Input
                id="eq-camera"
                type="url"
                value={form.cameraUrl}
                onChange={(e) => update("cameraUrl", e.target.value)}
                disabled={readOnly}
                aria-describedby="eq-camera-hint"
              />
              <span className="text-xs text-muted-foreground" id="eq-camera-hint">
                {t("equipmentForm:cameraUrlHint")}
              </span>
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
            <Link to="/admin/equipment">{readOnly ? t("equipmentForm:backToList") : t("equipmentForm:cancel")}</Link>
          </Button>
          {!readOnly && (
            <Button type="submit" disabled={saving}>
              {saving ? t("equipmentForm:saving") : t("equipmentForm:save")}
            </Button>
          )}
        </div>
      </form>
    </ConsoleShell>
  );
}
