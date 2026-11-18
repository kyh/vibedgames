import type { ControlsManifest } from "@repo/embed";

// Every way to drive, one list — the title card and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
export const CONTROLS: ControlsManifest = [
  { action: "accelerate", input: "W / ↑", method: "keys" },
  { action: "steer", input: "A D / ← →", method: "keys" },
  { action: "brake / reverse", input: "S / ↓", method: "keys" },
  { action: "drift (hold, release to boost)", input: "SPACE / SHIFT", method: "keys" },
  { action: "use item", input: "E / X", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "steer (the kart drives itself)", input: "DRAG", method: "touch" },
  { action: "drift (hold, release to boost)", input: "DRIFT", method: "touch" },
  { action: "brake", input: "BRAKE", method: "touch" },
  { action: "use item", input: "TAP THE ITEM", method: "touch" },
  { action: "accelerate", input: "RT / A", method: "controller" },
  { action: "steer", input: "STICK", method: "controller" },
  { action: "brake / reverse", input: "LT / B", method: "controller" },
  { action: "drift (hold, release to boost)", input: "RB / X", method: "controller" },
  { action: "use item", input: "Y / LB", method: "controller" },
];
