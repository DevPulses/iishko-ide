// FILE: logo.tsx
// Purpose: Render the IISHKO mark (a Cyrillic «И» with a terminal cursor) as an inline SVG.
// The letter follows the theme foreground; the cursor follows the theme accent.
// Layer: profile-ui shared component.

import type { SVGProps } from "react";
import { cn } from "./cn";

// Shared SVG path data for the IISHKO mark, in the 1024-unit icon grid.
export const IISHKO_LOGO_PATHS = ["M222 232h132v350l236-350h132v560H590V442L354 792H222z"] as const;
export const IISHKO_LOGO_CURSOR = { x: 750, y: 712, width: 56, height: 80 } as const;

export function IishkoLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const ariaLabel = props["aria-label"];

  return (
    <svg
      viewBox="206 216 616 592"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0 text-foreground", className)}
    >
      {IISHKO_LOGO_PATHS.map((path) => (
        <path key={path} d={path} fill="currentColor" />
      ))}
      <rect {...IISHKO_LOGO_CURSOR} fill="var(--color-text-accent, #ffd700)" />
    </svg>
  );
}
