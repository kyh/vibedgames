import type { ControlsManifest } from "@repo/embed";

// Every way to play, one list — the title card and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "WASD / arrows", action: "move (SHIFT runs)" },
  { method: "keys", input: "E / SPACE", action: "use tool / interact" },
  { method: "keys", input: "1–9", action: "switch tools" },
  { method: "keys", input: "I", action: "inventory" },
  { method: "keys", input: "M", action: "sound on / off" },
  { method: "mouse", input: "click", action: "use tool / interact" },
  { method: "mouse", input: "scroll", action: "switch tools" },
  { method: "touch", input: "drag stick", action: "move (full tilt runs)" },
  { method: "touch", input: "tap a square", action: "use tool / interact" },
  { method: "touch", input: "tap hotbar", action: "switch tools" },
  { method: "touch", input: "🎒", action: "inventory" },
  { method: "controller", input: "STICK", action: "move (full tilt runs)" },
  { method: "controller", input: "A", action: "use tool / interact" },
  { method: "controller", input: "LB / RB", action: "switch tools" },
  { method: "controller", input: "Y", action: "inventory" },
];
