import { controlHints } from "@repo/embed";
import type { ControlContext, ControlsManifest } from "@repo/embed";

// Every way to fly, one list — the start screen and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "M", action: "mute" },
  { method: "mouse", input: "MOUSE", action: "move" },
  { method: "mouse", input: "CLICK", action: "shoot" },
  { method: "touch", input: "DRAG", action: "move" },
  { method: "touch", input: "TAP", action: "shoot" },
  { method: "controller", input: "L-STICK", action: "move" },
  { method: "controller", input: "RT / A", action: "shoot" },
];

/** Start-screen lines, one binding per row ("MOUSE — move"). The context lets
 *  the caller force touch copy when touch is detected at runtime (a finger
 *  landing on a fine-pointer device) rather than only via media query. */
export function startScreenText(context?: ControlContext): string {
  return controlHints(CONTROLS, context)
    .map(([input, action]) => `${input} — ${action}`)
    .join("\n");
}
