import type { ControlsManifest } from "@repo/embed";

// Every way to play, one list — the start screen and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "WASD / ←→↑↓", action: "move" },
  { method: "keys", input: "SPACE", action: "drop a bomb" },
  { method: "keys", input: "R", action: "restart" },
  { method: "touch", input: "DRAG", action: "move" },
  { method: "touch", input: "💣", action: "drop a bomb" },
  { method: "touch", input: "TAP", action: "restart" },
  { method: "controller", input: "STICK / D-PAD", action: "move" },
  { method: "controller", input: "A", action: "drop a bomb" },
  { method: "controller", input: "START", action: "restart" },
];
