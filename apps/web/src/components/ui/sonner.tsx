import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// Hardcoded "light", not `next-themes`' `useTheme()` -- this app has exactly one theme (see
// index.css's own docstring on standardizing away the old dark/light split), so a theme
// *toggle* dependency has nothing to toggle. Worse than merely unused: `next-themes`'
// default is `theme: undefined` -> the destructure below falls back to "system", which
// would make Sonner itself resolve the OS's own `prefers-color-scheme` and render dark
// toasts on a dark-mode OS, contradicting the one light palette every other surface in this
// app enforces.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }

