import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ROLE_GRANTS, UserRole, evaluatePassword, requiresClinicAssignment, type MyClinic, type TenantDto, type UserDto } from "@crop/shared";
import { Loader2, Lock, Unlock, KeyRound, Mail } from "lucide-react";
import { cn } from "cn";
import { api, ApiError } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { PasswordStrength } from "../components/PasswordStrength.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { RolePermissionSummary } from "../components/RolePermissionSummary.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Badge } from "../components/ui/badge.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.js";

/** Same hex pairs as `.badge.online`/`.offline`/`.maintenance` in styles.css. */
const STATUS_BADGE_CLASS = {
  online: "bg-[#1d3d2b] text-[#5fdc8a]",
  offline: "bg-[#3d1d1d] text-[#ff8b8b]",
  maintenance: "bg-[#1d2f3d] text-[#6fb1ff]",
} as const;

/**
 * Full pt-BR pass. Rebuilt on shadcn/ui in a later pass -- `Table` for the user listing,
 * `Select` for the role/tenant pickers, `Checkbox` for the clinic multi-select and the
 * "active" toggle, `Badge` for status pills (same hex pairs as the old
 * `.badge.online`/`.maintenance`, carried over). `RolePermissionSummary` moved to shadcn in
 * the same pass as this page, one of its two callers -- see that component's own docstring.
 *
 * Registration rule this page enforces client-side (the server, `RegisterUserHandler`, is
 * the actual authority -- see `canGrantRole`/`ROLE_GRANTS` in roles.ts): "The System
 * Administrator registers users with the Clinic Manager, Supervisor, and Nursing profiles.
 * The Clinic Manager registers users with the Nursing profile." The role dropdown below is
 * built from `ROLE_GRANTS[actingUser.role]`, not the full `ASSIGNABLE_ROLES` list, so a
 * CLINIC_ADMIN is never even shown a role they aren't allowed to grant.
 *
 * There is no password field anymore -- `POST /users` sends the new account a secure,
 * single-use, 24h invitation link instead (see SendInvitationHandler); the new user chooses
 * their own first password when they redeem it at `/ativar-conta`.
 *
 * `DashboardPage`'s "Manage users" button that links here is deliberately still English --
 * see this file's own note in architecture.md on that seam.
 */
export default function AdminUsersPage() {
  const { t } = useTranslation(["adminUsers", "roles"]);
  const { user } = useAuth();
  const isSuperadmin = user?.role === "PLATFORM_ADMIN";
  const grantableRoles = useMemo(() => (user ? ROLE_GRANTS[user.role] : []), [user]);

  const [users, setUsers] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Reset-password: which row (if any) has its inline "new password" form open.
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  // Create user.
  const [newEmail, setNewEmail] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [newProfessionalRegistration, setNewProfessionalRegistration] = useState("");
  const [newRole, setNewRole] = useState<UserRole>(grantableRoles[0] ?? UserRole.NURSING);
  const [newActive, setNewActive] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Shown once, right after creation -- no password to relay anymore (see class docstring),
  // just confirmation that the invitation was sent.
  const [justCreated, setJustCreated] = useState<{ email: string; role: UserRole } | null>(null);

  // Which clinics the new account should be linked to -- required (non-empty) exactly when
  // `requiresClinicAssignment(newRole)`. Sourced from `GET /tenants` (every CLINIC tenant)
  // for a PLATFORM_ADMIN caller, or `GET /auth/me/clinics` (only the caller's own clinics --
  // RegisterUserHandler's actor-scope check rejects anything else) for a CLINIC_ADMIN.
  const [tenants, setTenants] = useState<TenantDto[]>([]);
  const [myClinics, setMyClinics] = useState<MyClinic[]>([]);
  const [selectedClinicIds, setSelectedClinicIds] = useState<string[]>([]);
  const clinicAssignmentNeeded = requiresClinicAssignment(newRole);
  const clinicOptions = useMemo(
    () =>
      isSuperadmin
        ? tenants.filter((tenant) => tenant.type === "CLINIC").map((tenant) => ({ id: tenant.id, name: tenant.name, deactivated: tenant.deactivated }))
        : myClinics.map((clinic) => ({ id: clinic.id, name: clinic.name, deactivated: clinic.deactivated })),
    [isSuperadmin, tenants, myClinics]
  );

  // PLATFORM_ADMIN-only legacy single-tenant picker, for the roles this feature doesn't
  // touch (LOCAL_IT, OPERATOR_ADMIN, OPERATIONAL_SUPERVISOR, OPERATOR, AUDITOR) -- see
  // CreateUserRequestSchema's own comment on `tenantId` vs `clinicTenantIds`.
  const [targetTenantId, setTargetTenantId] = useState("");

  useEffect(() => {
    // `/users` (`load`) is scoped to the caller's *active* tenant server-side, so it depends
    // on `user?.tenantId` -- same reasoning as ConsoleShell's own fix. `/tenants` and
    // `/auth/me/clinics` are platform-wide/home-tenant scoped respectively, immune to an
    // active-clinic switch, so they stay mount-once.
    void load();
    if (isSuperadmin) void loadTenants();
    else void loadMyClinics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenantId]);

  function handleRoleChange(role: UserRole) {
    setNewRole(role);
    setSelectedClinicIds([]);
    setTargetTenantId("");
  }

  function toggleClinic(id: string, checked: boolean) {
    setSelectedClinicIds((prev) => (checked ? [...prev, id] : prev.filter((existing) => existing !== id)));
  }

  async function loadTenants() {
    try {
      setTenants(await api.get<TenantDto[]>("/tenants"));
    } catch {
      // Non-fatal: the create-user form just won't offer a clinic picker if this fails --
      // the user list itself (this page's main purpose) still loads and works independently.
    }
  }

  async function loadMyClinics() {
    try {
      setMyClinics(await api.get<MyClinic[]>("/auth/me/clinics"));
    } catch {
      // Same non-fatal reasoning as loadTenants above.
    }
  }

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      setUsers(await api.get<UserDto[]>("/users"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("adminUsers:loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function toggleLock(target: UserDto) {
    setActionError(null);
    setActingOnId(target.id);
    try {
      await api.post(`/users/${target.id}/${target.locked ? "unlock" : "lock"}`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("adminUsers:genericActionError"));
    } finally {
      setActingOnId(null);
    }
  }

  async function resendInvitation(target: UserDto) {
    setActionError(null);
    setActingOnId(target.id);
    try {
      await api.post(`/users/${target.id}/resend-invitation`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("adminUsers:genericResendError"));
    } finally {
      setActingOnId(null);
    }
  }

  async function submitResetPassword(userId: string, ev: React.FormEvent) {
    ev.preventDefault();
    setActionError(null);
    setActingOnId(userId);
    try {
      await api.post(`/users/${userId}/reset-password`, { newPassword });
      setResettingId(null);
      setNewPassword("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("adminUsers:genericResetError"));
    } finally {
      setActingOnId(null);
    }
  }

  async function submitCreate(ev: React.FormEvent) {
    ev.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      await api.post("/users", {
        email: newEmail,
        firstName: newFirstName,
        lastName: newLastName,
        professionalRegistration: newProfessionalRegistration || undefined,
        role: newRole,
        active: newActive,
        ...(clinicAssignmentNeeded
          ? { clinicTenantIds: selectedClinicIds }
          : isSuperadmin && targetTenantId
            ? { tenantId: targetTenantId }
            : {}),
      });
      setJustCreated({ email: newEmail, role: newRole });
      setNewEmail("");
      setNewFirstName("");
      setNewLastName("");
      setNewProfessionalRegistration("");
      setSelectedClinicIds([]);
      setTargetTenantId("");
      setNewActive(true);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : t("adminUsers:genericCreateError"));
    } finally {
      setCreating(false);
    }
  }

  const canSubmitCreate = !creating && (!clinicAssignmentNeeded || selectedClinicIds.length > 0);

  return (
    <ConsoleShell activeNav="users" pageTitle={t("adminUsers:heading")}>
      {/* Same missing-heading gap `DashboardPage` had -- `ConsoleShell`'s topbar renders
          `pageTitle` as a plain `<strong>`, not a heading, so this page needs its own
          level-one one. Found by the same fresh a11y run against a reset demo stack. */}
      <h1 className="sr-only">{t("adminUsers:heading")}</h1>
      <Card className="mb-4">
        <CardContent>
          <h2 className="mt-0 text-lg font-semibold">{t("adminUsers:createTitle")}</h2>
          <p className="-mt-1.5 mb-3 text-sm text-muted-foreground">{t("adminUsers:inviteNote")}</p>
          <form onSubmit={submitCreate}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-user-email">{t("adminUsers:emailLabel")}</Label>
              <Input id="new-user-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
            </div>
            <div className="mt-3 flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="new-user-first-name">{t("adminUsers:firstNameLabel")}</Label>
                <Input id="new-user-first-name" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} required />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="new-user-last-name">{t("adminUsers:lastNameLabel")}</Label>
                <Input id="new-user-last-name" value={newLastName} onChange={(e) => setNewLastName(e.target.value)} required />
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-1.5">
              <Label htmlFor="new-user-registration">{t("adminUsers:professionalRegistrationLabel")}</Label>
              <Input
                id="new-user-registration"
                value={newProfessionalRegistration}
                onChange={(e) => setNewProfessionalRegistration(e.target.value)}
              />
            </div>

            <div className="mt-3.5 flex flex-col gap-1.5">
              <Label htmlFor="new-user-role">{t("adminUsers:roleLabel")}</Label>
              <Select value={newRole} onValueChange={(value) => handleRoleChange(value as UserRole)}>
                <SelectTrigger id="new-user-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {grantableRoles.map((role) => (
                    <SelectItem key={role} value={role}>
                      {t(`roles:${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <RolePermissionSummary role={newRole} />

            {clinicAssignmentNeeded ? (
              <fieldset className="rounded-lg border p-2.5">
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
                        />
                        {clinic.name}
                        {clinic.deactivated ? t("adminUsers:tenantDeactivatedSuffix") : ""}
                      </Label>
                    ))}
                  </div>
                )}
              </fieldset>
            ) : (
              isSuperadmin && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-user-tenant">{t("adminUsers:tenantLabel")}</Label>
                  <Select value={targetTenantId} onValueChange={setTargetTenantId}>
                    <SelectTrigger id="new-user-tenant" className="w-full">
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

            <div className="mt-3.5">
              <Label htmlFor="new-user-active" className="flex items-center gap-2 font-normal">
                <Checkbox id="new-user-active" checked={newActive} onCheckedChange={(checked) => setNewActive(checked === true)} />
                {t("adminUsers:statusActiveToggle")}
              </Label>
            </div>

            {createError && (
              <Alert variant="destructive" className="mt-3">
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={!canSubmitCreate} className="mt-3.5">
              {creating && <Loader2 className="animate-spin" />}
              {creating ? t("adminUsers:creating") : t("adminUsers:create")}
            </Button>
          </form>
          {justCreated && (
            <Alert role="status" className="mt-3.5 border-[#5fdc8a]">
              <AlertDescription>
                <strong className="text-[#166534]">{t("adminUsers:createdBannerTitle")}</strong> {t("adminUsers:createdBannerBody")}
                <div className="mt-2 font-mono text-sm">
                  {t("adminUsers:createdEmailField")}: {justCreated.email}
                  <br />
                  {t("adminUsers:createdRoleField")}: {t(`roles:${justCreated.role}`)}
                </div>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {actionError && (
            <Alert variant="destructive" className="mb-3">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          {loadError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {loadError}{" "}
                <button className="underline" onClick={() => void load()}>
                  {t("adminUsers:retry")}
                </button>
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <p aria-live="polite">{t("adminUsers:loading")}</p>
          ) : users.length === 0 ? (
            <p className="text-muted-foreground">{t("adminUsers:empty")}</p>
          ) : (
            <Table>
              <TableCaption className="sr-only">{t("adminUsers:tableCaption")}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adminUsers:colEmail")}</TableHead>
                  <TableHead>{t("adminUsers:colName")}</TableHead>
                  <TableHead>{t("adminUsers:colRole")}</TableHead>
                  <TableHead>{t("adminUsers:colMfa")}</TableHead>
                  <TableHead>{t("adminUsers:colActivation")}</TableHead>
                  <TableHead>{t("adminUsers:colStatus")}</TableHead>
                  <TableHead>{t("adminUsers:colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((target) => {
                  const rowResetEvaluation = evaluatePassword(newPassword, {
                    email: target.email,
                    firstName: target.firstName,
                    lastName: target.lastName,
                  });
                  return (
                    <TableRow key={target.id}>
                      <TableCell>{target.email}</TableCell>
                      <TableCell>{[target.firstName, target.lastName].filter(Boolean).join(" ") || "—"}</TableCell>
                      <TableCell>
                        {t(`roles:${target.role}`)}
                        {target.mustChangePassword && (
                          <>
                            {" "}
                            <Badge className={cn("border-transparent", STATUS_BADGE_CLASS.maintenance)}>
                              {t("adminUsers:mustChangeBadge")}
                            </Badge>
                          </>
                        )}
                      </TableCell>
                      <TableCell>{target.mfaEnrolled ? t("adminUsers:mfaEnrolled") : t("adminUsers:mfaPending")}</TableCell>
                      <TableCell>
                        <Badge className={cn("border-transparent", target.activated ? STATUS_BADGE_CLASS.online : STATUS_BADGE_CLASS.maintenance)}>
                          {target.activated ? t("adminUsers:activationDone") : t("adminUsers:activationPending")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={cn("border-transparent", target.locked ? STATUS_BADGE_CLASS.offline : STATUS_BADGE_CLASS.online)}>
                          {target.locked ? t("adminUsers:statusLocked") : t("adminUsers:statusActive")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="secondary"
                                size="icon-sm"
                                aria-label={target.locked ? t("adminUsers:unlock") : t("adminUsers:lock")}
                                disabled={actingOnId === target.id}
                                onClick={() => toggleLock(target)}
                              >
                                {target.locked ? <Unlock /> : <Lock />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{target.locked ? t("adminUsers:unlock") : t("adminUsers:lock")}</TooltipContent>
                          </Tooltip>
                          {target.activated ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="secondary"
                                  size="icon-sm"
                                  aria-label={t("adminUsers:resetPassword")}
                                  onClick={() => {
                                    setResettingId(resettingId === target.id ? null : target.id);
                                    setNewPassword("");
                                  }}
                                >
                                  <KeyRound />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t("adminUsers:resetPassword")}</TooltipContent>
                            </Tooltip>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="secondary"
                                  size="icon-sm"
                                  aria-label={t("adminUsers:resendInvite")}
                                  disabled={actingOnId === target.id}
                                  onClick={() => resendInvitation(target)}
                                >
                                  <Mail />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t("adminUsers:resendInvite")}</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        {resettingId === target.id && (
                          <form onSubmit={(ev) => submitResetPassword(target.id, ev)} className="mt-2 flex max-w-[260px] flex-col gap-2">
                            <Label className="sr-only" htmlFor={`reset-pw-${target.id}`}>
                              {t("adminUsers:newPasswordFor")} {target.email}
                            </Label>
                            <div className="flex gap-2">
                              <Input
                                id={`reset-pw-${target.id}`}
                                type="password"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                required
                                className="flex-1"
                              />
                              <Button type="submit" size="sm" disabled={actingOnId === target.id || !rowResetEvaluation.ok}>
                                {t("adminUsers:confirm")}
                              </Button>
                            </div>
                            <PasswordStrength password={newPassword} evaluation={rowResetEvaluation} />
                          </form>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </ConsoleShell>
  );
}
