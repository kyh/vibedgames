import type { ControlsManifest } from "@repo/embed";

// Every way to play, one list — the start screen and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
export const CONTROLS: ControlsManifest = [
  { action: "move", input: "WASD / ←→↑↓", method: "keys" },
  { action: "drop a bomb", input: "SPACE", method: "keys" },
  { action: "restart", input: "R", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "move", input: "DRAG", method: "touch" },
  { action: "drop a bomb", input: "💣", method: "touch" },
  { action: "restart", input: "TAP", method: "touch" },
  { action: "mute", input: "🔊", method: "touch" },
  { action: "move", input: "STICK / D-PAD", method: "controller" },
  { action: "drop a bomb", input: "A", method: "controller" },
  { action: "restart", input: "START", method: "controller" },
];
