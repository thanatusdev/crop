import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { evaluatePassword, type UserDto } from "@crop/shared";
import { Lock, Unlock, KeyRound, Mail, Plus, Eye, Pencil } from "lucide-react";
import { cn } from "cn";
import { api } from "../lib/api-client.js";
import { PasswordStrength } from "../components/PasswordStrength.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Badge } from "../components/ui/badge.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.js";

/** Same hex pairs as `.badge.online`/`.offline`/`.maintenance` in styles.css. */
const STATUS_BADGE_CLASS = {
  online: "bg-[#1d3d2b] text-[#5fdc8a]",
  offline: "bg-[#3d1d1d] text-[#ff8b8b]",
  maintenance: "bg-[#1d2f3d] text-[#6fb1ff]",
} as const;

/**
 * The user listing -- creation, viewing, and editing now live on their own route
 * (`UserFormPage`, `/admin/users/new` · `/:id` · `/:id/edit`), the same split
 * `AdminClinicsPage`/`ClinicFormPage` already use. Before `PATCH /users/:id` existed, this
 * page's own inline create form was the only way to touch a user beyond lock/unlock/reset
 * -password -- see `UserFormPage`'s own docstring for what moved and why `GET /users/:id`
 * had no caller until it did.
 *
 * Lock/unlock, reset-password, and resend-invite stay here, inline per row, unchanged:
 * none of the three is a form with fields to validate the way create/edit are, and moving
 * them to their own page would only add navigation for no benefit.
 *
 * `DashboardPage`'s "Manage users" button that links here is deliberately still English --
 * see this file's own note in architecture.md on that seam.
 */
export default function AdminUsersPage() {
  const { t } = useTranslation(["adminUsers", "roles"]);

  const [users, setUsers] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Reset-password: which row (if any) has its inline "new password" form open.
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  useEffect(() => {
    void load();
  }, []);

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

  return (
    <ConsoleShell activeNav="users" pageTitle={t("adminUsers:heading")}>
      <nav aria-label={t("adminUsers:breadcrumbList")}>
        <ol className="mb-3 flex list-none gap-1.5 p-0 text-sm text-muted-foreground">
          <li>{t("adminUsers:breadcrumbHome")}</li>
          <li aria-current="page" className="before:mr-1.5 before:content-['/']">
            {t("adminUsers:breadcrumbList")}
          </li>
        </ol>
      </nav>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <h1 className="mt-0 mb-1 text-xl font-semibold">{t("adminUsers:heading")}</h1>
        <Button asChild>
          <Link to="/admin/users/new">
            <Plus />
            {t("adminUsers:newUser")}
          </Link>
        </Button>
      </div>

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
                              <Button variant="secondary" size="icon-sm" aria-label={t("adminUsers:actionView")} asChild>
                                <Link to={`/admin/users/${target.id}`}>
                                  <Eye />
                                </Link>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t("adminUsers:actionView")}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="secondary" size="icon-sm" aria-label={t("adminUsers:actionEdit")} asChild>
                                <Link to={`/admin/users/${target.id}/edit`}>
                                  <Pencil />
                                </Link>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t("adminUsers:actionEdit")}</TooltipContent>
                          </Tooltip>
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
