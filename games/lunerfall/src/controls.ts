import type { ControlsManifest } from "@repo/embed";

// Every way to play, one list — the hub blurb and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
// Arrow keys, L-dash and the d-pad are unlisted aliases; ↓ drop-through and
// ↑ up-aim are left to be discovered.
export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "WASD", action: "move" },
  { method: "keys", input: "SPACE", action: "jump" },
  { method: "keys", input: "SHIFT", action: "dash" },
  { method: "keys", input: "J", action: "attack" },
  { method: "keys", input: "X", action: "attack" },
  { method: "keys", input: "K", action: "special" },
  { method: "keys", input: "M", action: "mute" },
  { method: "touch", input: "DRAG STICK", action: "move" },
  { method: "touch", input: "JUMP", action: "jump" },
  { method: "touch", input: "DASH", action: "dash" },
  { method: "touch", input: "ATK", action: "attack" },
  { method: "touch", input: "SP", action: "special" },
  { method: "controller", input: "STICK", action: "move" },
  { method: "controller", input: "A", action: "jump" },
  { method: "controller", input: "B", action: "dash" },
  { method: "controller", input: "X", action: "attack" },
  { method: "controller", input: "Y", action: "special" },
];
