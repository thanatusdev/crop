import type { ReactNode } from "react";
import { Logo } from "./Logo.js";
import { Card, CardContent } from "./ui/card.js";

/**
 * The shared shell both LoginPage and RecoveryPage sit in -- centered narrow column, logo
 * mark, brand title, tagline, then a bordered card, then an optional footer node below it
 * (the shield/security line on LoginPage, the "back to login" link on RecoveryPage). Every
 * page in this app now shares the same one light theme (see index.css's own docstring), so
 * this no longer needs its own `.theme-light` opt-in -- it owns its own light
 * `bg-background text-foreground` directly instead, the same way its old `.theme-light`
 * wrapper used to own it, rather than depending on `body`'s cascade.
 */
export function AuthCard({ tagline, footer, children }: { tagline: string; footer?: ReactNode; children: ReactNode }) {
  return (
    // `lang="pt-BR"` here, not on <html> (see main.tsx/index.html): only the auth cluster is
    // translated so far (WCAG 3.1.2, "Language of Parts") -- every other page is still
    // English, so the document-wide lang stays "en" until they get their own pass.
    <main className="min-h-screen bg-background pt-16 text-foreground" lang="pt-BR">
      <div className="mx-auto max-w-[420px] px-4">
        <div className="mb-6 flex flex-col items-center">
          <Logo />
          <h1 className="mt-3.5 mb-1 text-2xl font-semibold">RadLink</h1>
          <p className="text-center text-muted-foreground">{tagline}</p>
        </div>

        <Card>
          <CardContent>{children}</CardContent>
        </Card>

        {footer && <p className="mt-4 text-center text-xs text-muted-foreground">{footer}</p>}
      </div>
    </main>
  );
}


