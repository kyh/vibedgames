// Pause for a phone. It is keyboard-only in the run (Escape via @repo/embed),
// so without this a touch player can neither pause a descent nor reach the
// pause panel's sound toggle. Reskinned in the hub's pixel language —
// steel-blue border, night fill, teal press — over @repo/embed's shared
// cluster, which owns the safe-area anchoring and the 44px hit targets.

import { createTouchControls } from "@repo/embed";
import type { TouchControls } from "@repo/embed";

const CSS = `
.lf-touch {
  --vg-touch-gap: 10px;
  --vg-touch-bg: rgba(11, 14, 20, 0.78);
  --vg-touch-bg-active: rgba(52, 229, 200, 0.3);
  --vg-touch-border: 2px solid #33445e;
  --vg-touch-fg: #d8dee6;
  --vg-touch-radius: 3px;
  --vg-touch-glyph-size: 19px;
}
/* Portrait is the rotate gate's screen — nothing else floats over it. */
@media (orientation: portrait) and (pointer: coarse) {
  .lf-touch { display: none; }
}
`;

let controls: TouchControls | null = null;

/** Mount the cluster for a run. Idempotent while mounted. */
export const mountTouchHud = (): void => {
  controls ??= createTouchControls({
    className: "lf-touch",
    css: CSS,
    styleId: "lf-touch-css",
  });
};

/** The hub has nothing to freeze, so it carries no cluster at all. */
export const unmountTouchHud = (): void => {
  controls?.destroy();
  controls = null;
};
