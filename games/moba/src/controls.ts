import type { ControlsManifest } from "@repo/embed";

// Every way to play, one list — the menu control line and the pause overlay
// both render from this (filtered per device / connected pad by @repo/embed).
export const CONTROLS: ControlsManifest = [
  { action: "move", input: "←→↑↓", method: "keys" },
  { action: "abilities (aim by facing, Shift+key levels)", input: "Q W E R", method: "keys" },
  { action: "attack", input: "SPACE", method: "keys" },
  { action: "dash", input: "F", method: "keys" },
  { action: "items", input: "1-6", method: "keys" },
  { action: "shop", input: "B", method: "keys" },
  { action: "scores", input: "TAB", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "move", input: "DRAG", method: "touch" },
  { action: "attack", input: "2ND FINGER", method: "touch" },
  { action: "cast", input: "ABILITY BUTTONS", method: "touch" },
  { action: "buy items", input: "SHOP", method: "touch" },
  { action: "scoreboard", input: "SCORES", method: "touch" },
  { action: "move", input: "L-STICK / D-PAD", method: "controller" },
  { action: "cast Q W E R", input: "X Y B RB", method: "controller" },
  { action: "attack", input: "A", method: "controller" },
  { action: "dash", input: "RT", method: "controller" },
  { action: "shop", input: "SELECT", method: "controller" },
  { action: "scores", input: "START", method: "controller" },
];
