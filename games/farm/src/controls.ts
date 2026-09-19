import type { ControlsManifest } from "@repo/embed";

// Every way to play, one list — the title card and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
export const CONTROLS: ControlsManifest = [
  { action: "move (SHIFT runs)", input: "WASD / arrows", method: "keys" },
  { action: "use tool / interact", input: "E / SPACE", method: "keys" },
  { action: "switch tools", input: "1–9 / 0", method: "keys" },
  { action: "inventory", input: "I", method: "keys" },
  { action: "sound on / off", input: "M", method: "keys" },
  { action: "use tool / interact", input: "click", method: "mouse" },
  { action: "switch tools", input: "scroll", method: "mouse" },
  { action: "move (full tilt runs)", input: "drag stick", method: "touch" },
  { action: "use tool / interact", input: "tap a square", method: "touch" },
  { action: "switch tools", input: "tap hotbar", method: "touch" },
  { action: "inventory", input: "🎒", method: "touch" },
  { action: "move (full tilt runs)", input: "STICK", method: "controller" },
  { action: "use tool / interact", input: "A", method: "controller" },
  { action: "switch tools", input: "LB / RB", method: "controller" },
  { action: "inventory", input: "Y", method: "controller" },
];
