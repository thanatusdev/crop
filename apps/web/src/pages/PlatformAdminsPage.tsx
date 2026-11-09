import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UserDto } from "@crop/shared";
import { Lock, Mail, Unlock } from "lucide-react";
import { cn } from "cn";
import { api } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Badge } from "../components/ui/badge.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.js";

/** Same hex pairs as AdminUsersPage's own STATUS_BADGE_CLASS. */
const STATUS_BADGE_CLASS = {
  online: "bg-[#1d3d2b] text-[#5fdc8a]",
  offline: "bg-[#3d1d1d] text-[#ff8b8b]",
  maintenance: "bg-[#1d2f3d] text-[#6fb1ff]",
} as const;

/**
 * The platform's own administrators (`GET`/`POST /platform/admins`), PLATFORM_ADMIN only.
 * Inviting sends the same activation link as any other new account. Lock/unlock reuse
 * `/users/:id/lock|unlock`; the API refuses locking yourself or the last active platform
 * admin, and the lock button is simply not offered on your own row.
 */
export default function PlatformAdminsPage() {
  const { t } = useTranslation(["platformAdmins", "adminUsers"]);
  const { user } = useAuth();

  const [admins, setAdmins] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      setAdmins(await api.get<UserDto[]>("/platform/admins"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("platformAdmins:loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function invite(ev: React.FormEvent) {
    ev.preventDefault();
    setInviteError(null);
    setInvitedEmail(null);
    setInviting(true);
    try {
      await api.post("/platform/admins", { email, firstName, lastName });
      setInvitedEmail(email);
      setEmail("");
      setFirstName("");
      setLastName("");
      await load();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : t("platformAdmins:inviteError"));
    } finally {
      setInviting(false);
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

  return (
    <ConsoleShell activeNav="platformAdmins" pageTitle={t("platformAdmins:heading")}>
      <div className="mb-4">
        <h1 className="mt-0 mb-1 text-xl font-semibold">{t("platformAdmins:heading")}</h1>
        <p className="mt-0 text-muted-foreground">{t("platformAdmins:subheading")}</p>
      </div>

      <Card className="mb-4">
        <CardContent>
          <h2 className="mt-0 mb-1 text-base font-semibold">{t("platformAdmins:inviteHeading")}</h2>
          <p className="mt-0 mb-3 text-sm text-muted-foreground">{t("adminUsers:inviteNote")}</p>
          {invitedEmail && (
            <Alert className="mb-3">
              <AlertDescription>{t("platformAdmins:invited", { email: invitedEmail })}</AlertDescription>
            </Alert>
          )}
          {inviteError && (
            <Alert variant="destructive" className="mb-3">
              <AlertDescription>{inviteError}</AlertDescription>
            </Alert>
          )}
          <form onSubmit={invite} className="grid grid-cols-1 items-end gap-3 md:grid-cols-[2fr_1fr_1fr_auto]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pa-email">{t("adminUsers:emailLabel")}</Label>
              <Input id="pa-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pa-first-name">{t("adminUsers:firstNameLabel")}</Label>
              <Input id="pa-first-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pa-last-name">{t("adminUsers:lastNameLabel")}</Label>
              <Input id="pa-last-name" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
            </div>
            <Button type="submit" disabled={inviting}>
              {inviting ? t("adminUsers:creating") : t("adminUsers:create")}
            </Button>
          </form>
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
          ) : (
            <Table>
              <TableCaption className="sr-only">{t("platformAdmins:tableCaption")}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adminUsers:colEmail")}</TableHead>
                  <TableHead>{t("adminUsers:colName")}</TableHead>
                  <TableHead>{t("adminUsers:colMfa")}</TableHead>
                  <TableHead>{t("adminUsers:colActivation")}</TableHead>
                  <TableHead>{t("adminUsers:colStatus")}</TableHead>
                  <TableHead>{t("adminUsers:colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {admins.map((target) => {
                  const isSelf = target.id === user?.sub;
                  return (
                    <TableRow key={target.id}>
                      <TableCell>
                        {target.email}
                        {isSelf && <span className="ml-1 text-muted-foreground">{t("platformAdmins:you")}</span>}
                      </TableCell>
                      <TableCell>{[target.firstName, target.lastName].filter(Boolean).join(" ") || "—"}</TableCell>
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
                          {!isSelf && (
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
                          )}
                          {!target.activated && (
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
