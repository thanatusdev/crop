import { useAuth } from "../lib/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent } from "../components/ui/card.js";

/**
 * Landing page for the clinic-staff roles that still have no dedicated screen of their own
 * (LOCAL_SUPERVISOR, LOCAL_IT -- see role-routes.ts and packages/shared/src/roles.ts).
 * Deliberately not DashboardPage: that page's whole surface is remote-session/equipment
 * operation, which these roles don't do. This is a stub so the role has *somewhere* real to
 * land, not a placeholder for that future surface.
 *
 * NURSING used to land here too, until the quick-action patient-preparation feature gave it
 * a real home (`/enfermagem`, see NursingPage.tsx and role-routes.ts) -- it is no longer one
 * of "the clinic-staff roles that have never had one before". LOCAL_SUPERVISOR can also
 * reach `/enfermagem` via ConsoleShell's nav (`canManageQueue`), but its own dedicated
 * landing page -- session supervision -- doesn't exist yet, so it still lands here by
 * default. LOCAL_IT has no queue access at all (QueueController's own @Roles excludes it).
 *
 * Stays English like the rest of the still-untranslated app (unlike LoginPage/RecoveryPage)
 * -- see docs/architecture.md for why only some pages have their own pt-BR pass so far. Now
 * on the shared shadcn/Tailwind light theme like every other migrated page, though -- this
 * stub has no old dark-styled content of its own to stay self-consistent with, so there was
 * no reason to leave it on the old stylesheet.
 */
export default function ClinicHomePage() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b bg-card px-6 py-4">
        <strong>RadLink</strong>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {user?.role} · tenant {user?.tenantId.slice(0, 8)}
          </span>
          <Button variant="secondary" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-[960px] px-5 py-8">
        <h1 className="mt-0 mb-4 text-xl font-semibold">Clinic</h1>
        <Card>
          <CardContent>
            <p>Patient queue and clinic management screens for this role are not built yet.</p>
            <p className="text-muted-foreground">
              Your account and permissions are already set up -- this is just a placeholder home
              screen until the clinic-side surface exists.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

