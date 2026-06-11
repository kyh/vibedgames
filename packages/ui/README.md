# @repo/ui

Shared UI components, hooks, and global styles for the web app.

## Stack

- [Base UI](https://base-ui.com) primitives, shadcn-style component wrappers
- [Tailwind CSS 4](https://tailwindcss.com) + `class-variance-authority` + `tailwind-merge`
- [motion](https://motion.dev) for animation, [sonner](https://sonner.emilkowal.ski) for toasts

## Usage

Components are imported per-file (no barrel export):

```ts
import { Button } from "@repo/ui/components/button";
import { useIsMobile } from "@repo/ui/hooks/use-mobile";
import { cn } from "@repo/ui/lib/utils";
```

Global styles + Tailwind theme:

```css
@import "@repo/ui/globals.css";
```

## Contents

- `src/components/` — button, dialog, sheet, sidebar, field, input, OTP field, tooltip, avatar, skeleton, spinner, logo, …
- `src/hooks/` — `use-mobile` (breakpoint detection), `use-shake` (error shake animation, reduced-motion aware)
- `src/lib/utils.ts` — `cn()` class merger
- `src/styles/globals.css` — Tailwind theme tokens
