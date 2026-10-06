import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ROLE_GRANTS, UserRole, requiresClinicAssignment, type MyClinic, type TenantDto, type UserDto } from "@crop/shared";
import { Loader2 } from "lucide-react";
import { api, ApiError } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { RolePermissionSummary } from "../components/RolePermissionSummary.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { RequiredLabel } from "../components/TenantFormFields.js";

type Mode = "create" | "edit" | "view";

/**
 * Register / edit / view one user, on its own route -- the `UsersController` counterpart to
 * `ClinicFormPage`/`OperatorFormPage`, same "three modes, one component" shape. Before this
 * page existed, creation lived inline on `AdminUsersPage` and there was no edit at all (see
 * `PATCH /users/:id`'s own docstring on why) -- the orphaned `GET /users/:id` this page now
 * consumes was exactly the endpoint an edit screen was designed around.
 *
 * `email` is read-only in every mode, including `create` -- wait, no: it's the one field
 * `create` still collects (it has to, there is no account without one) but `edit`/`view`
 * both render as plain disabled text, never submitted in a `PATCH` body at all (see
 * `UpdateUserRequestSchema`'s own docstring on why it's permanently absent from that
 * contract). `role`/`clinicTenantIds` are editable in both `create` and `edit` -- unlike
 * `ClinicFormPage`'s CNPJ, nothing about granting a role is create-only; `UpdateUserHandler`
 * enforces the identical `canGrantRole`/`isRoleAllowedInTenantType`/`requiresClinicAssignment`
 * rules either way (see that handler's own docstring for the one rule editing adds: the
 * acting admin must be able to grant *both* the current and the destination role).
 *
 * The post-create "invitation sent" confirmation (email + role, no password -- there isn't
 * one, see `inviteNote`) renders in-page with a manual link back to the list, rather than an
 * immediate `navigate(...)` the way `ClinicFormPage`/`OperatorFormPage` both do after their
 * own successful create: confirming a security-sensitive invitation really went out to the
 * right address is worth not auto-dismissing.
 */
export default function UserFormPage() {
  const { t } = useTranslation(["userForm", "adminUsers", "roles"]);
  const navigate = useNavigate();
  const { user: actingUser } = useAuth();
  const { id, mode: routeMode } = useParams<{ id?: string; mode?: string }>();

  const mode: Mode = !id ? "create" : routeMode === "edit" ? "edit" : "view";
  const readOnly = mode === "view";
  const isSuperadmin = actingUser?.role === "PLATFORM_ADMIN";
  const grantableRoles = useMemo(() => (actingUser ? ROLE_GRANTS[actingUser.role] : []), [actingUser]);

  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [professionalRegistration, setProfessionalRegistration] = useState("");
  const [role, setRole] = useState<UserRole>(grantableRoles[0] ?? UserRole.NURSING);
  const [active, setActive] = useState(true);

  const roleOptions = useMemo(
    // The loaded user's own current role always has a matching <option>, even if the
    // acting admin could no longer grant it today (an edge case: ROLE_GRANTS changed, or a
    // different admin created this account) -- same "the loaded value is never missing
    // from its own picker" guarantee ClinicFormPage's loadedManager gives.
    () => (role && !grantableRoles.includes(role) ? [role, ...grantableRoles] : grantableRoles),
    [grantableRoles, role]
  );

  const [loadedUser, setLoadedUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(mode !== "create");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{ email: string; role: UserRole } | null>(null);

  const [tenants, setTenants] = useState<TenantDto[]>([]);
  const [myClinics, setMyClinics] = useState<MyClinic[]>([]);
  const [selectedClinicIds, setSelectedClinicIds] = useState<string[]>([]);
  const clinicAssignmentNeeded = requiresClinicAssignment(role);
  const clinicOptions = useMemo(
    () =>
      isSuperadmin
        ? tenants.filter((tenant) => tenant.type === "CLINIC").map((tenant) => ({ id: tenant.id, name: tenant.name, deactivated: tenant.deactivated }))
        : myClinics.map((clinic) => ({ id: clinic.id, name: clinic.name, deactivated: clinic.deactivated })),
    [isSuperadmin, tenants, myClinics]
  );

  // PLATFORM_ADMIN-only legacy single-tenant picker, same as AdminUsersPage's own create
  // form used -- for the roles this feature doesn't touch (LOCAL_IT, OPERATOR_ADMIN,
  // OPERATIONAL_SUPERVISOR, OPERATOR, AUDITOR). Create-only: there is no equivalent on
  // `UpdateUserRequestSchema` -- a user's home tenant never changes after creation.
  const [targetTenantId, setTargetTenantId] = useState("");

  useEffect(() => {
    void load();
    if (isSuperadmin) void loadTenants();
    else void loadMyClinics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadTenants() {
    try {
      setTenants(await api.get<TenantDto[]>("/tenants"));
    } catch {
      // Non-fatal -- same reasoning as AdminUsersPage's own identical fetch.
    }
  }

  async function loadMyClinics() {
    try {
      setMyClinics(await api.get<MyClinic[]>("/auth/me/clinics"));
    } catch {
      // Same non-fatal reasoning.
    }
  }

  async function load() {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await api.get<UserDto>(`/users/${id}`);
      setLoadedUser(loaded);
      setEmail(loaded.email);
      setFirstName(loaded.firstName ?? "");
      setLastName(loaded.lastName ?? "");
      setProfessionalRegistration(loaded.professionalRegistration ?? "");
      setRole(loaded.role);
      setSelectedClinicIds(loaded.clinicTenantIds);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t("userForm:loadError"));
    } finally {
      setLoading(false);
    }
  }

  function handleRoleChange(value: UserRole) {
    setRole(value);
    if (!requiresClinicAssignment(value)) setSelectedClinicIds([]);
    setTargetTenantId("");
  }

  function toggleClinic(clinicId: string, checked: boolean) {
    setSelectedClinicIds((prev) => (checked ? [...prev, clinicId] : prev.filter((existing) => existing !== clinicId)));
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      if (mode === "create") {
        await api.post("/users", {
          email,
          firstName,
          lastName,
          professionalRegistration: professionalRegistration || undefined,
          role,
          active,
          ...(clinicAssignmentNeeded
            ? { clinicTenantIds: selectedClinicIds }
            : isSuperadmin && targetTenantId
              ? { tenantId: targetTenantId }
              : {}),
        });
        setJustCreated({ email, role });
        return;
      }

      await api.patch(`/users/${id}`, {
        firstName,
        lastName,
        professionalRegistration: professionalRegistration || null,
        role,
        ...(clinicAssignmentNeeded ? { clinicTenantIds: selectedClinicIds } : {}),
      });
      navigate("/admin/users");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : t("userForm:genericSaveError"));
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = !saving && (!clinicAssignmentNeeded || selectedClinicIds.length > 0);

  const title = mode === "create" ? t("userForm:createTitle") : mode === "edit" ? t("userForm:editTitle") : t("userForm:viewTitle");
  const subtitle = mode === "create" ? t("userForm:createSubtitle") : mode === "edit" ? t("userForm:editSubtitle") : t("userForm:viewSubtitle");
  const breadcrumbLeaf = mode === "create" ? t("userForm:breadcrumbNew") : mode === "edit" ? t("userForm:breadcrumbEdit") : t("userForm:breadcrumbView");

  if (loading) {
    return (
      <ConsoleShell activeNav="users" pageTitle={title}>
        <p aria-live="polite">{t("userForm:loading")}</p>
      </ConsoleShell>
    );
  }

  if (loadError) {
    return (
      <ConsoleShell activeNav="users" pageTitle={title}>
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <Button variant="secondary" className="mt-3" asChild>
          <Link to="/admin/users">{t("userForm:backToList")}</Link>
        </Button>
      </ConsoleShell>
    );
  }

  if (justCreated) {
    return (
      <ConsoleShell activeNav="users" pageTitle={title}>
        <Alert role="status" className="border-[#5fdc8a]">
          <AlertDescription>
            <strong className="text-[#166534]">{t("adminUsers:createdBannerTitle")}</strong> {t("adminUsers:createdBannerBody")}
            <div className="mt-2 font-mono text-sm">
              {t("adminUsers:createdEmailField")}: {justCreated.email}
              <br />
              {t("adminUsers:createdRoleField")}: {t(`roles:${justCreated.role}`)}
            </div>
          </AlertDescription>
        </Alert>
        <Button className="mt-3.5" asChild>
          <Link to="/admin/users">{t("userForm:backToList")}</Link>
        </Button>
      </ConsoleShell>
    );
  }

  return (
    <ConsoleShell activeNav="users" pageTitle={title}>
      <nav className="mb-2.5 text-[13px] text-muted-foreground" aria-label={breadcrumbLeaf}>
        <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          <li>{t("userForm:breadcrumbHome")}</li>
          <li>
            <span aria-hidden="true">›</span>{" "}
            <Link className="text-primary underline" to="/admin/users">
              {t("userForm:breadcrumbList")}
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
            <Link to={`/admin/users/${id}/edit`}>{t("userForm:editThis")}</Link>
          </Button>
        ) : (
          <span className="text-[13px] text-muted-foreground">{t("userForm:requiredLegend")}</span>
        )}
      </div>

      <form onSubmit={submit}>
        <Card className="mb-4 py-0">
          <CardContent className="grid gap-3.5 py-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-email">{t("adminUsers:emailLabel")}</Label>
              {mode === "create" ? (
                <Input id="user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              ) : (
                <p className="min-h-6 py-2.5 text-sm" id="user-email">
                  {email}
                </p>
              )}
              <span className="text-xs text-muted-foreground">{mode === "create" ? t("adminUsers:inviteNote") : t("userForm:emailImmutableHint")}</span>
            </div>

            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="user-first-name">
                  {t("adminUsers:firstNameLabel")}
                </RequiredLabel>
                <Input id="user-first-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} required disabled={readOnly} />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <RequiredLabel required={!readOnly} htmlFor="user-last-name">
                  {t("adminUsers:lastNameLabel")}
                </RequiredLabel>
                <Input id="user-last-name" value={lastName} onChange={(e) => setLastName(e.target.value)} required disabled={readOnly} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-registration">{t("adminUsers:professionalRegistrationLabel")}</Label>
              <Input
                id="user-registration"
                value={professionalRegistration}
                onChange={(e) => setProfessionalRegistration(e.target.value)}
                disabled={readOnly}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-role">{t("adminUsers:roleLabel")}</Label>
              <Select value={role} onValueChange={(value) => handleRoleChange(value as UserRole)} disabled={readOnly}>
                <SelectTrigger id="user-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`roles:${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!readOnly && <RolePermissionSummary role={role} />}

            {clinicAssignmentNeeded ? (
              <fieldset className="rounded-lg border p-2.5" disabled={readOnly}>
                <legend className="px-1 text-sm font-medium">{t("adminUsers:clinicsLabel")}</legend>
                <p className="mt-0 text-xs text-muted-foreground">{t("adminUsers:clinicsHint")}</p>
                {clinicOptions.length === 0 ? (
                  <p className="text-muted-foreground">{t("adminUsers:clinicsEmpty")}</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {clinicOptions.map((clinic) => (
                      <Label key={clinic.id} className="flex items-center gap-2 font-normal">
                        <Checkbox
                          checked={selectedClinicIds.includes(clinic.id)}
                          onCheckedChange={(checked) => toggleClinic(clinic.id, checked === true)}
                          disabled={readOnly}
                        />
                        {clinic.name}
                        {clinic.deactivated ? t("adminUsers:tenantDeactivatedSuffix") : ""}
                      </Label>
                    ))}
                  </div>
                )}
              </fieldset>
            ) : (
              mode === "create" &&
              isSuperadmin && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="user-tenant">{t("adminUsers:tenantLabel")}</Label>
                  <Select value={targetTenantId} onValueChange={setTargetTenantId}>
                    <SelectTrigger id="user-tenant" className="w-full">
                      <SelectValue placeholder={t("adminUsers:tenantPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {tenants
                        .filter((tenant) => tenant.type !== "PLATFORM")
                        .map((tenant) => (
                          <SelectItem key={tenant.id} value={tenant.id}>
                            {tenant.name}
                            {tenant.deactivated ? t("adminUsers:tenantDeactivatedSuffix") : ""}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              )
            )}

            {mode === "create" && (
              <div>
                <Label htmlFor="user-active" className="flex items-center gap-2 font-normal">
                  <Checkbox id="user-active" checked={active} onCheckedChange={(checked) => setActive(checked === true)} />
                  {t("adminUsers:statusActiveToggle")}
                </Label>
              </div>
            )}

            {mode !== "create" && loadedUser && (
              <p className="text-xs text-muted-foreground">
                {loadedUser.locked ? t("adminUsers:statusLocked") : t("adminUsers:statusActive")} ·{" "}
                {loadedUser.activated ? t("adminUsers:activationDone") : t("adminUsers:activationPending")}
              </p>
            )}
          </CardContent>
        </Card>

        {saveError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap justify-end gap-2.5">
          <Button variant="secondary" asChild>
            <Link to="/admin/users">{readOnly ? t("userForm:backToList") : t("userForm:cancel")}</Link>
          </Button>
          {!readOnly && (
            <Button type="submit" disabled={!canSubmit}>
              {saving && <Loader2 className="animate-spin" />}
              {saving ? t("userForm:saving") : mode === "create" ? t("adminUsers:create") : t("userForm:save")}
            </Button>
          )}
        </div>
      </form>
    </ConsoleShell>
  );
}
