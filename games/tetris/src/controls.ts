import { activeMethods, controlGroups } from "@repo/embed";
import type { ControlMethod, ControlsManifest } from "@repo/embed";

// Every way to play, one list — the title legend and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
// Camera rows stay condensed to the three headline gestures (the same copy
// the pause overlay always used); the collapse banner still teaches hands-up.
export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "←→↑↓", action: "move" },
  { method: "keys", input: "R", action: "rotate" },
  { method: "keys", input: "Q / E", action: "turn view" },
  { method: "keys", input: "SPACE", action: "hard drop" },
  { method: "keys", input: "SHIFT", action: "soft drop" },
  { method: "keys", input: "C", action: "hold piece" },
  { method: "keys", input: "F", action: "power sweep" },
  { method: "keys", input: "V", action: "recenter" },
  { method: "keys", input: "M", action: "mute" },
  { method: "keys", input: "P", action: "pause" },
  { method: "touch", input: "DRAG", action: "move" },
  { method: "touch", input: "ROT", action: "rotate" },
  { method: "touch", input: "⟲ ⟳", action: "turn view" },
  { method: "touch", input: "DROP tap", action: "hard drop" },
  { method: "touch", input: "DROP hold", action: "soft drop" },
  { method: "touch", input: "HOLD", action: "hold piece" },
  { method: "touch", input: "PWR", action: "power sweep" },
  { method: "camera", input: "📷 lean", action: "move" },
  { method: "camera", input: "📷 twist", action: "rotate" },
  { method: "camera", input: "📷 T-pose", action: "power sweep" },
  { method: "controller", input: "L-STICK / D-PAD", action: "move" },
  { method: "controller", input: "A", action: "rotate" },
  { method: "controller", input: "LB / RB", action: "turn view" },
  { method: "controller", input: "B", action: "hard drop" },
  { method: "controller", input: "LT / RT", action: "soft drop" },
  { method: "controller", input: "X", action: "hold piece" },
  { method: "controller", input: "Y", action: "power sweep" },
  { method: "controller", input: "START", action: "pause" },
];

/** Display name per input method — shared by the title legend and the pause
 *  overlay so every instruction surface speaks the same words. */
export const METHOD_LABEL: Record<ControlMethod, string> = {
  keys: "keys",
  mouse: "mouse",
  touch: "touch",
  camera: "webcam",
  controller: "pad",
};

/** Title-legend rows, one per visible method ("keys · move ←→↑↓ · …"). */
export function legendRows(): readonly { label: string; text: string }[] {
  return controlGroups(CONTROLS).map((group) => ({
    label: METHOD_LABEL[group.method],
    text: group.entries.map((entry) => `${entry.action} ${entry.input}`).join(" · "),
  }));
}

/** Title-banner sub line: the headline camera verbs plus how to start. */
export function titleSubText(): string {
  const camera = CONTROLS.filter((entry) => entry.method === "camera")
    .slice(0, 2)
    .map((entry) => `${entry.input} to ${entry.action}`);
  const methods = activeMethods();
  const start = methods.has("controller")
    ? "any button to start"
    : methods.has("touch")
      ? "tap to start"
      : "Enter / Space to start";
  return [...camera, start].join(" · ");
}
