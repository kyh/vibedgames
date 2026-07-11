import type { ControlsManifest } from "@repo/embed";

// Every way to fight, one list — the lobby help line and the pause overlay
// both render from this (filtered per device / connected pad by @repo/embed).
// Item keys 5-0 and Tab-scoreboard on keyboard are deliberately absent from
// the keys rows (today's copy leaves them to be discovered in-game).
export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "WASD", action: "move" },
  { method: "mouse", input: "MOUSE", action: "look" },
  { method: "mouse", input: "LMB", action: "attack" },
  { method: "keys", input: "SPACE", action: "jump" },
  { method: "keys", input: "SHIFT", action: "dash" },
  { method: "keys", input: "1-4", action: "abilities" },
  { method: "keys", input: "B", action: "shop" },
  { method: "keys", input: "M", action: "mute" },
  { method: "touch", input: "LEFT STICK", action: "move" },
  { method: "touch", input: "RIGHT STICK", action: "aim + attack" },
  { method: "touch", input: "1-4", action: "abilities" },
  { method: "touch", input: "DASH / HOP / JUMP", action: "mobility" },
  { method: "touch", input: "B", action: "shop" },
  { method: "controller", input: "L-STICK", action: "move" },
  { method: "controller", input: "R-STICK", action: "look" },
  { method: "controller", input: "RT", action: "attack" },
  { method: "controller", input: "A", action: "jump" },
  { method: "controller", input: "B", action: "dash" },
  { method: "controller", input: "X/Y/LB/RB", action: "abilities" },
  { method: "controller", input: "SELECT", action: "shop" },
  { method: "controller", input: "START", action: "scoreboard" },
];
