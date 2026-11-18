import type { ControlsManifest } from "@repo/embed";

export const CONTROLS: ControlsManifest = [
  { action: "move", input: "WASD / ←→↑↓", method: "keys" },
  { action: "drop a bomb", input: "SPACE", method: "keys" },
  { action: "restart", input: "R", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "move", input: "DRAG", method: "touch" },
  { action: "drop a bomb", input: "💣", method: "touch" },
  { action: "restart", input: "TAP", method: "touch" },
  { action: "move", input: "STICK / D-PAD", method: "controller" },
  { action: "drop a bomb", input: "A", method: "controller" },
  { action: "restart", input: "START", method: "controller" },
];
