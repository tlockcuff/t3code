import { usageTone } from "@t3tools/client-runtime/state/provider-usage";

/**
 * Tailwind class names for usage urgency.
 *
 * These live in the web app rather than in `client-runtime` because Tailwind only scans this app's
 * sources; class names authored in the shared package are never compiled into the stylesheet.
 */

export function usageToneClass(remainingPercent: number): string {
  switch (usageTone(remainingPercent)) {
    case "critical":
      return "text-destructive";
    case "warning":
      return "text-warning";
    default:
      return "text-muted-foreground";
  }
}

export function usageBarClass(remainingPercent: number): string {
  switch (usageTone(remainingPercent)) {
    case "critical":
      return "bg-destructive";
    case "warning":
      return "bg-warning";
    default:
      return "bg-primary/70";
  }
}
