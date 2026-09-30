import { useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

/**
 * A password field with a show/hide toggle (the eye icon in the RadLink mock) plus an
 * optional `labelExtra` node rendered on the same row as the label (used for the "Esqueci a
 * senha" link, right-aligned, exactly where the mock places it).
 */
export function PasswordField({
  id,
  label,
  labelExtra,
  value,
  onChange,
  showLabel,
  hideLabel,
  required,
  autoFocus,
}: {
  id: string;
  label: string;
  labelExtra?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  showLabel: string;
  hideLabel: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <Label htmlFor={id}>{label}</Label>
        {labelExtra}
      </div>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          autoFocus={autoFocus}
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? hideLabel : showLabel}
          className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {visible ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
        </button>
      </div>
    </div>
  );
}

