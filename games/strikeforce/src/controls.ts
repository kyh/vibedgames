import type { ControlMethod, ControlsManifest } from "@repo/embed";

// Every way to play, one list — the web app's controls panel and the pause
// overlay render from this (filtered per device by @repo/embed; controller
// rows only while a pad is plugged in). The game's own title legend and
// Controls panel say the same thing in its own type.
export const CONTROLS: ControlsManifest = [
  { action: "move", input: "WASD", method: "keys" },
  { action: "look", input: "MOUSE", method: "mouse" },
  { action: "fire", input: "LEFT CLICK", method: "mouse" },
  { action: "aim down sights", input: "RIGHT CLICK", method: "mouse" },
  { action: "reload", input: "R", method: "keys" },
  { action: "swap weapon", input: "Q / 1 2 / WHEEL", method: "keys" },
  { action: "hold to cut a relay (Mission)", input: "E", method: "keys" },
  { action: "jump", input: "SPACE", method: "keys" },
  { action: "sprint", input: "SHIFT", method: "keys" },
  { action: "crouch", input: "C / CTRL", method: "keys" },
  { action: "melee", input: "F", method: "keys" },
  { action: "scoreboard", input: "HOLD TAB", method: "keys" },
  { action: "pause", input: "ESC / P", method: "keys" },
  { action: "move", input: "LEFT THUMB", method: "touch" },
  { action: "look", input: "RIGHT THUMB", method: "touch" },
  { action: "fire · aim · reload · jump", input: "ON-SCREEN BUTTONS", method: "touch" },
  { action: "hold to cut a relay", input: "USE BUTTON", method: "touch" },
  { action: "move · look", input: "L-STICK · R-STICK", method: "controller" },
  { action: "fire · aim", input: "RT · LT", method: "controller" },
  { action: "reload / hold to cut a relay", input: "X", method: "controller" },
  { action: "swap weapon", input: "Y / D-PAD", method: "controller" },
  { action: "jump", input: "A", method: "controller" },
  { action: "crouch", input: "B / LB", method: "controller" },
  { action: "sprint", input: "L-STICK CLICK", method: "controller" },
  { action: "pause", input: "START", method: "controller" },
];

/** Display name per input method, for every instruction surface. */
export const METHOD_LABEL = {
  camera: "camera",
  controller: "pad",
  keys: "keys",
  mouse: "mouse",
  touch: "touch",
} satisfies Record<ControlMethod, string>;
