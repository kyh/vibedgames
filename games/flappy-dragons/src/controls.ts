import type { ControlsManifest } from "@repo/embed";

export const CONTROLS: ControlsManifest = [
  { action: "flap", input: "SPACE / ↑", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "flap", input: "CLICK", method: "mouse" },
  { action: "flap", input: "TAP", method: "touch" },
  { action: "jump or flap your arms", input: "📷", method: "camera" },
  { action: "flap", input: "A", method: "controller" },
];
