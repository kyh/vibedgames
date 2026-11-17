import { isPlayables } from "@repo/embed";
import type { ControlsManifest } from "@repo/embed";

import { handCameraState } from "./input/camera";

const MUTE_KEY = "M";

export const CONTROLS: ControlsManifest = [
  { action: "serve · power shot · rematch", input: "SPACE", method: "keys" },
  { action: "mute", input: MUTE_KEY, method: "keys" },
  { action: "steer the paddle", input: "MOUSE", method: "mouse" },
  { action: "serve · power shot · rematch", input: "CLICK", method: "mouse" },
  { action: "steer the paddle", input: "FINGER", method: "touch" },
  { action: "serve · power shot · rematch", input: "TAP", method: "touch" },
  { action: "steer the paddle", input: "✋ HAND", method: "camera" },
  { action: "serve · power shot · rematch", input: "✊ FIST", method: "camera" },
  { action: "steer the paddle", input: "STICK", method: "controller" },
  { action: "serve · power shot · rematch", input: "A", method: "controller" },
];

/** What this session can actually use: no hand cam until it is live, and no
 *  mute key where the platform owns sound (YouTube Playables). */
export const visibleControls = (): ControlsManifest => {
  const camera = handCameraState() === "live";
  const mute = !isPlayables();
  return CONTROLS.filter(
    (entry) => (camera || entry.method !== "camera") && (mute || entry.input !== MUTE_KEY),
  );
};
