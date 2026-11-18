import type { ControlsManifest } from "@repo/embed";

export const CONTROLS: ControlsManifest = [
  { action: "shoot", input: "SPACE", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "move", input: "MOUSE", method: "mouse" },
  { action: "shoot", input: "CLICK", method: "mouse" },
  { action: "move", input: "DRAG", method: "touch" },
  { action: "shoot", input: "HOLD", method: "touch" },
  { action: "move", input: "L-STICK", method: "controller" },
  { action: "shoot", input: "RT / A", method: "controller" },
];
