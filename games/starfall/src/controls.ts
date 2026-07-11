import type { ControlsManifest } from "@repo/embed";

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
