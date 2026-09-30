import { Checkbox } from "./ui/checkbox.js";
import { Label } from "./ui/label.js";
import { cn } from "cn";

export interface CheckboxCardOption<T extends string> {
  value: T;
  title: string;
  hint?: string;
}

interface CheckboxCardGroupProps<T extends string> {
  name: string;
  legend: string;
  options: readonly CheckboxCardOption<T>[];
  value: readonly T[];
  onChange: (value: T[]) => void;
  required?: boolean;
  disabled?: boolean;
  /** Shown under the group, `role="alert"`, when `required` and nothing is selected. */
  requiredError?: string;
}

/**
 * A multi-select sibling to `RadioCardGroup` -- same card visuals (the two share every
 * Tailwind class for the card itself; a checkbox card and a radio card are visually identical,
 * so the classes are duplicated inline rather than factored into a third shared component for
 * two four-line style strings), Radix `Checkbox` instead of `RadioGroupItem`.
 *
 * "At least one selected" cannot be expressed as native HTML `required` the way
 * `RadioCardGroup` uses it: a required *checkbox* demands that specific box be checked, not
 * "at least one box in this group," so there is no native equivalent of a required radio
 * group for checkboxes. `requiredError` is therefore a plain rendered message, shown when
 * `required` is true and `value` is empty -- a client-side echo of what
 * `declaredModalities.min(1)` already enforces server-side, not a replacement for it.
 */
export function CheckboxCardGroup<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  required = false,
  disabled = false,
  requiredError,
}: CheckboxCardGroupProps<T>) {
  function toggle(optionValue: T, checked: boolean) {
    if (checked) onChange([...value, optionValue]);
    else onChange(value.filter((v) => v !== optionValue));
  }

  const showRequiredError = required && value.length === 0 && !!requiredError;

  return (
    <fieldset className="mb-3.5 border-0 p-0">
      <legend className="mb-2 p-0 text-sm">
        {legend}
        {required && (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </legend>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-2.5">
        {options.map((option) => (
          <Label
            key={option.value}
            htmlFor={`${name}-${option.value}`}
            className={cn(
              "flex items-start gap-2.5 rounded-[10px] border border-input p-3.5 font-normal",
              "has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent",
              "has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-primary has-[:focus-visible]:outline-offset-2",
              disabled ? "cursor-default opacity-60" : "cursor-pointer hover:border-primary"
            )}
          >
            <Checkbox
              id={`${name}-${option.value}`}
              name={name}
              value={option.value}
              checked={value.includes(option.value)}
              disabled={disabled}
              onCheckedChange={(checked) => toggle(option.value, checked === true)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-semibold">{option.title}</span>
              {option.hint && <span className="mt-0.5 block text-xs text-muted-foreground">{option.hint}</span>}
            </span>
          </Label>
        ))}
      </div>
      {showRequiredError && (
        <p className="mt-1 text-sm text-destructive" role="alert">
          {requiredError}
        </p>
      )}
    </fieldset>
  );
}
