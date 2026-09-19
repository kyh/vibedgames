import type { ControlsManifest } from "@repo/embed";

// Every way to play, one list — the web app's controls panel and the pause
// overlay render from this (filtered per device by @repo/embed). The in-game
// hint strip in index.html repeats the keyboard rows for desktop players.
export const CONTROLS: ControlsManifest = [
  { action: "move", input: "WASD", method: "keys" },
  { action: "aim", input: "MOUSE", method: "mouse" },
  { action: "shoot", input: "CLICK", method: "mouse" },
  { action: "hold to aim super, release to fire", input: "SPACE", method: "keys" },
  { action: "hold to aim super, release to fire", input: "RIGHT-CLICK", method: "mouse" },
  { action: "time of day", input: "T", method: "keys" },
  { action: "pause", input: "P", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "move", input: "LEFT THUMB", method: "touch" },
  { action: "drag to aim, release to fire", input: "RIGHT THUMB", method: "touch" },
  { action: "auto-aim shot", input: "TAP", method: "touch" },
  { action: "hold to aim super, release to fire", input: "SUPER", method: "touch" },
];
