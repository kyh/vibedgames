import { createTouchControls } from "@repo/embed";
import type { TouchControls } from "@repo/embed";

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
export const mountTouchControls = () => {
  controls ??= createTouchControls({
    className: "farm-touch",
    css: CSS,
    styleId: "farm-touch-style",
  });
};
