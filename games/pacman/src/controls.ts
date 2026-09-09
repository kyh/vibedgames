import { controlHints } from "@repo/embed";
import type { ControlsManifest } from "@repo/embed";

// Every way to chomp, one list — the title banner and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
// Camera rows always show: face control is the game's core input, not a bonus.
export const CONTROLS: ControlsManifest = [
  { action: "chomp", input: "SPACE", method: "keys" },
  { action: "turn", input: "← →", method: "keys" },
  { action: "reverse", input: "↓", method: "keys" },
  { action: "selfie cam", input: "SHIFT", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "restart", input: "R", method: "keys" },
  { action: "restart", input: "CLICK", method: "mouse" },
  { action: "chomp", input: "SWIPE ↑", method: "touch" },
  { action: "turn", input: "SWIPE ← →", method: "touch" },
  { action: "reverse", input: "SWIPE ↓", method: "touch" },
  { action: "selfie cam", input: "🤳", method: "touch" },
  { action: "restart", input: "TAP / ↻", method: "touch" },
  { action: "face camera on / off", input: "📷", method: "touch" },
  { action: "mute", input: "🔊", method: "touch" },
  { action: "chomp", input: "open mouth", method: "camera" },
  { action: "turn", input: "turn head", method: "camera" },
  { action: "chomp", input: "A / STICK ↑", method: "controller" },
  { action: "turn", input: "D-PAD / STICK ← →", method: "controller" },
  { action: "reverse", input: "D-PAD / STICK ↓", method: "controller" },
  { action: "selfie cam", input: "LB", method: "controller" },
  { action: "restart", input: "START", method: "controller" },
];

/** The merged restart inputs ("R / CLICK", "TAP / ↻") for win/gameover prose. */
export const restartHint = (): string => {
  const row = controlHints(CONTROLS).find(([, action]) => action === "restart");
  return row ? row[0] : "R";
};
