import type { ControlsManifest } from "@repo/embed";

import { handCameraState } from "./input/camera";

export const CONTROLS: ControlsManifest = [
  { action: "serve · power shot · rematch", input: "SPACE", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "steer the paddle", input: "MOUSE", method: "mouse" },
  { action: "serve · power shot · rematch", input: "CLICK", method: "mouse" },
  { action: "steer the paddle", input: "FINGER", method: "touch" },
  { action: "serve · power shot · rematch", input: "TAP", method: "touch" },
  { action: "mute", input: "🔊", method: "touch" },
  { action: "steer the paddle", input: "✋ HAND", method: "camera" },
  { action: "serve · power shot · rematch", input: "✊ FIST", method: "camera" },
  { action: "steer the paddle", input: "STICK", method: "controller" },
  { action: "serve · power shot · rematch", input: "A", method: "controller" },
];

export function visibleControls(): ControlsManifest {
  if (handCameraState() === "live") {
    return CONTROLS;
  }
  return CONTROLS.filter((entry) => entry.method !== "camera");
}
