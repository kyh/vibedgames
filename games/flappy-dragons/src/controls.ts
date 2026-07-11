import type { ControlsManifest } from "@repo/embed";

// Every way to flap, one list — the start screen and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "SPACE / ↑", action: "flap" },
  { method: "keys", input: "M", action: "mute" },
  { method: "mouse", input: "CLICK", action: "flap" },
  { method: "touch", input: "TAP", action: "flap" },
  { method: "camera", input: "📷", action: "jump or flap your arms" },
  { method: "controller", input: "A", action: "flap" },
];
