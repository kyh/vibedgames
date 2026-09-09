import type { ControlsManifest } from "@repo/embed";

// Every way to flap, one list — the start screen and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
export const CONTROLS: ControlsManifest = [
  { action: "flap", input: "SPACE / ↑", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "flap", input: "CLICK", method: "mouse" },
  { action: "flap", input: "TAP", method: "touch" },
  { action: "mute", input: "🔊", method: "touch" },
  { action: "jump or flap your arms", input: "📷", method: "camera" },
  { action: "flap", input: "A", method: "controller" },
];
