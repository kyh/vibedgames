import type { ControlsManifest } from "@repo/embed";

// Every way to fight, one list — the lobby help line and the pause overlay
// both render from this (filtered per device / connected pad by @repo/embed).
// Item keys 5-0 and Tab-scoreboard on keyboard are deliberately absent from
// the keys rows (today's copy leaves them to be discovered in-game).
export const CONTROLS: ControlsManifest = [
  { action: "move", input: "WASD", method: "keys" },
  { action: "look", input: "MOUSE", method: "mouse" },
  { action: "attack", input: "LMB", method: "mouse" },
  { action: "jump", input: "SPACE", method: "keys" },
  { action: "dash", input: "SHIFT", method: "keys" },
  { action: "abilities", input: "1-4", method: "keys" },
  { action: "shop", input: "B", method: "keys" },
  { action: "kit guide", input: "H", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "move", input: "LEFT STICK", method: "touch" },
  { action: "aim + attack", input: "RIGHT STICK", method: "touch" },
  { action: "abilities", input: "1-4", method: "touch" },
  { action: "mobility", input: "DASH / HOP / JUMP", method: "touch" },
  { action: "shop", input: "B", method: "touch" },
  { action: "ability guide", input: "YOUR KIT", method: "touch" },
  { action: "move", input: "L-STICK", method: "controller" },
  { action: "look", input: "R-STICK", method: "controller" },
  { action: "attack", input: "RT", method: "controller" },
  { action: "jump", input: "A", method: "controller" },
  { action: "dash", input: "B", method: "controller" },
  { action: "abilities", input: "X/Y/LB/RB", method: "controller" },
  { action: "shop", input: "SELECT", method: "controller" },
  { action: "kit guide", input: "L3", method: "controller" },
  { action: "scoreboard", input: "START", method: "controller" },
];
