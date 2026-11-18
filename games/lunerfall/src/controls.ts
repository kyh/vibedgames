import type { ControlsManifest } from "@repo/embed";

export const CONTROLS: ControlsManifest = [
  { action: "move", input: "WASD", method: "keys" },
  { action: "jump", input: "SPACE", method: "keys" },
  { action: "dash", input: "SHIFT", method: "keys" },
  { action: "attack", input: "J", method: "keys" },
  { action: "attack", input: "X", method: "keys" },
  { action: "special", input: "K", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "move", input: "DRAG STICK", method: "touch" },
  { action: "jump", input: "JUMP", method: "touch" },
  { action: "dash", input: "DASH", method: "touch" },
  { action: "attack", input: "ATK", method: "touch" },
  { action: "special", input: "SP", method: "touch" },
  { action: "pause", input: "⏸", method: "touch" },
  { action: "move", input: "STICK", method: "controller" },
  { action: "jump", input: "A", method: "controller" },
  { action: "dash", input: "B", method: "controller" },
  { action: "attack", input: "X", method: "controller" },
  { action: "special", input: "Y", method: "controller" },
];
