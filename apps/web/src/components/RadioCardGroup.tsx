import { RadioGroup, RadioGroupItem } from "./ui/radio-group.js";
import { Label } from "./ui/label.js";
import { cn } from "cn";

export interface RadioCardOption<T extends string> {
  value: T;
  title: string;
  hint?: string;
}

interface RadioCardGroupProps<T extends string> {
  /** Shared `name` for the underlying radio inputs -- what makes them one exclusive group. */
  name: string;
  legend: string;
  options: readonly RadioCardOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  required?: boolean;
  disabled?: boolean;
}

/**
 * A mutually-exclusive choice rendered as selectable cards rather than a `<select>`, for when
 * each option needs a line of supporting detail (the equipment form's modality picker: a
 * title plus what the modality covers).
 *
 * Built on Radix `RadioGroup`/`RadioGroupItem`, not a set of divs with click handlers and
 * `role="radio"` -- deliberately, for the same reason as the pre-migration version: arrow-key
 * navigation within the group, form participation, and correct screen-reader announcement
 * ("Modalidade, Ressonância Magnética, radio button, 1 of 3") all come from the primitive and
 * cannot silently regress. The visible selected-card state is still CSS-only, now via
 * Tailwind's `has-[[data-state=checked]]:` on the `<Label>` wrapping each item -- the direct
 * equivalent of the old `.radio-card:has(input:checked)`, just keyed on Radix's own
 * `data-state` attribute instead of `:checked`.
 *
 * `hint` is inside the same `<Label>` as the title, so it is announced together with the
 * option instead of being orphaned text a screen-reader user would never reach.
 */
export function RadioCardGroup<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  required = false,
  disabled = false,
}: RadioCardGroupProps<T>) {
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
      <RadioGroup
        name={name}
        value={value ?? ""}
        onValueChange={(next) => onChange(next as T)}
        required={required}
        disabled={disabled}
        className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-2.5"
      >
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
            <RadioGroupItem value={option.value} id={`${name}-${option.value}`} className="mt-0.5" />
            <span>
              <span className="block text-sm font-semibold">{option.title}</span>
              {option.hint && <span className="mt-0.5 block text-xs text-muted-foreground">{option.hint}</span>}
            </span>
          </Label>
        ))}
      </RadioGroup>
    </fieldset>
  );
}
