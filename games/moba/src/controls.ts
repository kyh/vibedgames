import { controlHints } from "@repo/embed";
import type { ControlsManifest } from "@repo/embed";

// Every way to play, one list — the menu control line and the pause overlay
// both render from this (filtered per device / connected pad by @repo/embed).
export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "←→↑↓", action: "move" },
  { method: "keys", input: "Q W E R", action: "abilities (aim by facing, Shift+key levels)" },
  { method: "keys", input: "SPACE", action: "attack" },
  { method: "keys", input: "F", action: "dash" },
  { method: "keys", input: "1-6", action: "items" },
  { method: "keys", input: "B", action: "shop" },
  { method: "keys", input: "TAB", action: "scores" },
  { method: "keys", input: "M", action: "mute" },
  { method: "touch", input: "DRAG", action: "move" },
  { method: "touch", input: "2ND FINGER", action: "attack" },
  { method: "touch", input: "ABILITY BUTTONS", action: "cast" },
  { method: "touch", input: "SHOP", action: "buy items" },
  { method: "touch", input: "SCORES", action: "scoreboard" },
  { method: "controller", input: "L-STICK / D-PAD", action: "move" },
  { method: "controller", input: "X Y B RB", action: "cast Q W E R" },
  { method: "controller", input: "A", action: "attack" },
  { method: "controller", input: "RT", action: "dash" },
  { method: "controller", input: "SELECT", action: "shop" },
  { method: "controller", input: "START", action: "scores" },
];

/** Menu control line ("←→↑↓ move · SPACE attack · …"), joined like the HUD
 *  taught it before — inputs for the same verb merge across visible methods. */
export function menuControlsText(): string {
  return controlHints(CONTROLS)
    .map(([input, action]) => `${input} ${action}`)
    .join(" · ");
}
