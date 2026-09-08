import type { ControlsManifest } from "@repo/embed";

import { handCameraState } from "./input/camera";

export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "SPACE", action: "serve · power shot · rematch" },
  { method: "keys", input: "M", action: "mute" },
  { method: "mouse", input: "MOUSE", action: "steer the paddle" },
  { method: "mouse", input: "CLICK", action: "serve · power shot · rematch" },
  { method: "touch", input: "FINGER", action: "steer the paddle" },
  { method: "touch", input: "TAP", action: "serve · power shot · rematch" },
  { method: "touch", input: "🔊", action: "mute" },
  { method: "camera", input: "✋ HAND", action: "steer the paddle" },
  { method: "camera", input: "✊ FIST", action: "serve · power shot · rematch" },
  { method: "controller", input: "STICK", action: "steer the paddle" },
  { method: "controller", input: "A", action: "serve · power shot · rematch" },
];

export function visibleControls(): ControlsManifest {
  if (handCameraState() === "live") return CONTROLS;
  return CONTROLS.filter((entry) => entry.method !== "camera");
}
