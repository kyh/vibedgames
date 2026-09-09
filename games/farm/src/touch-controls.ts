// Pause is Escape-only, so on a phone it does not exist: the valley cannot be
// paused and the wooden pause sign (controls, how-to-play, sound) is
// unreachable. The shared @repo/embed cluster is a no-op on a fine pointer.

import { createTouchControls } from "@repo/embed";
import type { TouchControls } from "@repo/embed";

// Farm's palette (parchment on wood, as the pause sign), dropped below the
// HUD's gold/health panel so the two never overlap, and rounded to match the
// 🎒 button facing it across the screen.
const CSS = `
.farm-touch {
  top: calc(env(safe-area-inset-top, 0px) + 88px);
  --vg-touch-bg: rgba(42, 30, 14, 0.55);
  --vg-touch-bg-active: rgba(122, 74, 24, 0.75);
  --vg-touch-border: 2px solid rgba(243, 226, 191, 0.5);
  --vg-touch-fg: #fff6d5;
  --vg-touch-radius: 999px;
}
`;

let controls: TouchControls | null = null;

/** Mount once, from the title screen — the cluster outlives every scene, and
 *  the gallery and trailer routes never reach it. */
export const mountTouchControls = (): void => {
  controls ??= createTouchControls({
    className: "farm-touch",
    css: CSS,
    styleId: "farm-touch-style",
  });
};
