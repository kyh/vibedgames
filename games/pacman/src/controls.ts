import { controlHints } from "@repo/embed";
import type { ControlsManifest } from "@repo/embed";

// Every way to chomp, one list — the title banner and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
// Camera rows always show: face control is the game's core input, not a bonus.
export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "SPACE", action: "chomp" },
  { method: "keys", input: "← →", action: "turn" },
  { method: "keys", input: "↓", action: "reverse" },
  { method: "keys", input: "SHIFT", action: "selfie cam" },
  { method: "keys", input: "M", action: "mute" },
  { method: "keys", input: "R", action: "restart" },
  { method: "mouse", input: "CLICK", action: "restart" },
  { method: "touch", input: "SWIPE ↑", action: "chomp" },
  { method: "touch", input: "SWIPE ← →", action: "turn" },
  { method: "touch", input: "SWIPE ↓", action: "reverse" },
  { method: "touch", input: "🤳", action: "selfie cam" },
  { method: "touch", input: "TAP / ↻", action: "restart" },
  { method: "camera", input: "open mouth", action: "chomp" },
  { method: "camera", input: "turn head", action: "turn" },
  { method: "controller", input: "A / STICK ↑", action: "chomp" },
  { method: "controller", input: "D-PAD / STICK ← →", action: "turn" },
  { method: "controller", input: "D-PAD / STICK ↓", action: "reverse" },
  { method: "controller", input: "LB", action: "selfie cam" },
  { method: "controller", input: "START", action: "restart" },
];

/** The merged restart inputs ("R / CLICK", "TAP / ↻") for win/gameover prose. */
export function restartHint(): string {
  const row = controlHints(CONTROLS).find(([, action]) => action === "restart");
  return row ? row[0] : "R";
}
