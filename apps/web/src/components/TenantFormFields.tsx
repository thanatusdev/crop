import type { ReactNode } from "react";
import { BR_STATES } from "@crop/shared";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { CardHeader, CardTitle } from "./ui/card.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js";

/**
 * Shared between `ClinicFormPage` and `OperatorFormPage` -- both register a `Tenant` (a
 * `CLINIC` or an `OPERATOR_PROVIDER`) through the identical institutional-address shape
 * `CreateTenantRequestSchema`/`UpdateTenantRequestSchema` require of either type (see that
 * schema's own docstring for why the two were unified). Extracted once both pages existed
 * and the address block below turned out byte-for-byte identical except for which i18n
 * namespace supplied the strings -- and even that is mostly shared: "CEP"/"Rua"/"Bairro" is
 * not clinic-specific wording, so most callers pass `clinicForm:*` keys regardless of which
 * page they're rendering from, reserving a page's own namespace for strings that actually
 * differ (headings, hints that name "clínica" vs "operadora").
 *
 * Deliberately *not* extracted into one generic `TenantFormPage` parameterized by type: the
 * two pages' field sets, CSV export, and nav wiring differ enough that a single parameterized
 * component would be more conditionals than shared code -- see the plan this was built from.
 */

/** A field label carrying the required marker. Module scope, not redeclared per page: a
 * component declared inside another component's body remounts its whole subtree on every
 * render instead of updating in place, same reasoning `UnitFormPage`'s identical helper has. */
export function RequiredLabel({ htmlFor, required, children }: { htmlFor: string; required: boolean; children: ReactNode }) {
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

export function FormSectionHeader({ step, title }: { step: string; title: string }) {
  return (
    <CardHeader className="flex-row items-center gap-3 space-y-0 border-b [.border-b]:pb-4">
      <span className="rounded-md bg-accent px-2 py-0.5 text-xs font-bold tabular-nums text-accent-foreground">{step}</span>
      <CardTitle className="text-sm font-semibold tracking-wide uppercase">{title}</CardTitle>
    </CardHeader>
  );
}

/** The seven-field registered-address shape both `CreateTenantRequestSchema` and
 * `UpdateTenantRequestSchema` require (`complement` alone optional, same as there). Takes
 * already-translated strings rather than a namespace, so a caller can mix a shared
 * `clinicForm:*` string for a label with no clinic-specific meaning and its own namespace
 * for one that does, without this component knowing or caring which. */
export interface AddressFormValues {
  zipCode: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
}

export interface AddressFieldLabels {
  zipCodeLabel: string;
  zipCodePlaceholder: string;
  zipCodeHint: string;
  streetLabel: string;
  streetPlaceholder: string;
  numberLabel: string;
  numberPlaceholder: string;
  complementLabel: string;
  complementPlaceholder: string;
  districtLabel: string;
  districtPlaceholder: string;
  cityLabel: string;
  cityPlaceholder: string;
  stateLabel: string;
  statePlaceholder: string;
}

export function AddressFormFields({
  idPrefix,
  values,
  onChange,
  readOnly,
  labels,
}: {
  idPrefix: string;
  values: AddressFormValues;
  onChange: <K extends keyof AddressFormValues>(key: K, value: AddressFormValues[K]) => void;
  readOnly: boolean;
  labels: AddressFieldLabels;
}) {
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
        <div className="mb-3.5 flex flex-col gap-1.5">
          <RequiredLabel required={!readOnly} htmlFor={`${idPrefix}-zip`}>
            {labels.zipCodeLabel}
          </RequiredLabel>
          <Input
            id={`${idPrefix}-zip`}
            value={values.zipCode}
            placeholder={labels.zipCodePlaceholder}
            onChange={(e) => onChange("zipCode", e.target.value)}
            required
            disabled={readOnly}
            aria-describedby={`${idPrefix}-zip-hint`}
          />
          <span className="text-xs text-muted-foreground" id={`${idPrefix}-zip-hint`}>
            {labels.zipCodeHint}
          </span>
        </div>
        <div className="mb-3.5 flex flex-col gap-1.5">
          <RequiredLabel required={!readOnly} htmlFor={`${idPrefix}-street`}>
            {labels.streetLabel}
          </RequiredLabel>
          <Input
            id={`${idPrefix}-street`}
            value={values.street}
            placeholder={labels.streetPlaceholder}
            onChange={(e) => onChange("street", e.target.value)}
            required
            disabled={readOnly}
          />
        </div>
        <div className="mb-3.5 flex flex-col gap-1.5">
          <RequiredLabel required={!readOnly} htmlFor={`${idPrefix}-number`}>
            {labels.numberLabel}
          </RequiredLabel>
          <Input
            id={`${idPrefix}-number`}
            value={values.number}
            placeholder={labels.numberPlaceholder}
            onChange={(e) => onChange("number", e.target.value)}
            required
            disabled={readOnly}
          />
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4">
        <div className="mb-3.5 flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-complement`}>{labels.complementLabel}</Label>
          <Input
            id={`${idPrefix}-complement`}
            value={values.complement}
            placeholder={labels.complementPlaceholder}
            onChange={(e) => onChange("complement", e.target.value)}
            disabled={readOnly}
          />
        </div>
        <div className="mb-3.5 flex flex-col gap-1.5">
          <RequiredLabel required={!readOnly} htmlFor={`${idPrefix}-district`}>
            {labels.districtLabel}
          </RequiredLabel>
          <Input
            id={`${idPrefix}-district`}
            value={values.district}
            placeholder={labels.districtPlaceholder}
            onChange={(e) => onChange("district", e.target.value)}
            required
            disabled={readOnly}
          />
        </div>
        <div className="mb-3.5 flex flex-col gap-1.5">
          <RequiredLabel required={!readOnly} htmlFor={`${idPrefix}-city`}>
            {labels.cityLabel}
          </RequiredLabel>
          <Input
            id={`${idPrefix}-city`}
            value={values.city}
            placeholder={labels.cityPlaceholder}
            onChange={(e) => onChange("city", e.target.value)}
            required
            disabled={readOnly}
          />
        </div>
        <div className="mb-3.5 flex flex-col gap-1.5">
          <RequiredLabel required={!readOnly} htmlFor={`${idPrefix}-state`}>
            {labels.stateLabel}
          </RequiredLabel>
          <Select value={values.state || undefined} onValueChange={(value) => onChange("state", value)} disabled={readOnly}>
            <SelectTrigger id={`${idPrefix}-state`} className="w-full">
              <SelectValue placeholder={labels.statePlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {BR_STATES.map((state) => (
                <SelectItem key={state} value={state}>
                  {state}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </>
  );
}
