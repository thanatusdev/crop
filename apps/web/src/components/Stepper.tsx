import { Check } from "lucide-react";
import { cn } from "cn";

export type StepStatus = "complete" | "active" | "pending";

export interface StepDefinition {
  label: string;
  status: StepStatus;
}

/**
 * A progress indicator, not a tablist -- unlike RecoveryPage's "Solicitar Token"/"Nova
 * Senha" tabs (which are two interchangeable views a user can freely switch between), these
 * steps represent a one-way sequence the user has already moved through (see the mock:
 * step 1 shows a checkmark, not a clickable tab). Built as an `<ol>` with `aria-current`,
 * not `role="tablist"`/`role="tab"` -- using tab semantics here would tell a screen-reader
 * user they can activate step 1 and go back, which they can't.
 */
export function Stepper({ steps }: { steps: StepDefinition[] }) {
  return (
    <ol className="mb-5 flex list-none gap-4 p-0 text-sm">
      {steps.map((step, index) => (
        <li
          key={step.label}
          aria-current={step.status === "active" ? "step" : undefined}
          className={cn("flex items-center gap-1.5", step.status === "pending" ? "text-muted-foreground" : "text-foreground", step.status === "active" && "font-bold")}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex size-5 flex-shrink-0 items-center justify-center rounded-full text-[11px]",
              step.status === "pending" ? "bg-secondary text-muted-foreground" : "bg-primary text-primary-foreground"
            )}
          >
            {step.status === "complete" ? <Check className="size-3" /> : index + 1}
          </span>
          {step.label}
          {/* Visually-hidden, since the checkmark/number + aria-current already convey this
              visually and via the accessibility tree respectively -- this is the one piece
              (which of the three states a *non*-active step is in) neither of those two
              alone communicates to a screen reader. */}
          <span className="sr-only">
            {step.status === "complete" ? " (concluído)" : step.status === "active" ? " (etapa atual)" : " (pendente)"}
          </span>
        </li>
      ))}
    </ol>
  );
}

