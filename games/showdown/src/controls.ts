import type { ControlMethod, ControlsManifest } from "@repo/embed";

// Every way to play, one list — the web app's controls panel and the pause
// overlay render from this (filtered per device by @repo/embed; controller
// rows only while a pad is plugged in).
export const CONTROLS: ControlsManifest = [
  { action: "move", input: "WASD", method: "keys" },
  { action: "evade", input: "SHIFT", method: "keys" },
  { action: "aim", input: "MOUSE", method: "mouse" },
  { action: "attack", input: "CLICK", method: "mouse" },
  { action: "hold to aim super, release to fire", input: "SPACE", method: "keys" },
  { action: "hold to aim super, release to fire", input: "RIGHT-CLICK", method: "mouse" },
  { action: "time of day", input: "T", method: "keys" },
  { action: "pause", input: "ESC", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "move", input: "LEFT THUMB", method: "touch" },
  { action: "drag to aim, release to fire", input: "RIGHT THUMB", method: "touch" },
  { action: "auto-aim attack", input: "TAP", method: "touch" },
  { action: "hold to aim super, release to fire", input: "SUPER", method: "touch" },
  { action: "evade", input: "DODGE BUTTON", method: "touch" },
  { action: "pause", input: "PAUSE BUTTON", method: "touch" },
  { action: "move", input: "L-STICK", method: "controller" },
  { action: "aim", input: "R-STICK", method: "controller" },
  { action: "attack", input: "RT / A", method: "controller" },
  { action: "hold to aim super, release to fire", input: "LT / RB", method: "controller" },
  { action: "evade", input: "B / LB", method: "controller" },
  { action: "pause", input: "START", method: "controller" },
];

/** Display name per input method — shared by every instruction surface so
 *  they all speak the same words. */
export const METHOD_LABEL = {
  camera: "camera",
  controller: "pad",
  keys: "keys",
  mouse: "mouse",
  touch: "touch",
} satisfies Record<ControlMethod, string>;
