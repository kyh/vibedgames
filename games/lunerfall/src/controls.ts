import type { ControlsManifest } from "@repo/embed";

// Every way to play, one list — the hub blurb and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
// Arrow keys, L-dash and the d-pad are unlisted aliases; ↓ drop-through and
// ↑ up-aim are left to be discovered.
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
  { action: "mute", input: "🔊", method: "touch" },
  { action: "move", input: "STICK", method: "controller" },
  { action: "jump", input: "A", method: "controller" },
  { action: "dash", input: "B", method: "controller" },
  { action: "attack", input: "X", method: "controller" },
  { action: "special", input: "Y", method: "controller" },
];
