import { controlGroups } from "@repo/embed";
import type { ControlMethod, ControlsManifest } from "@repo/embed";

export const CONTROLS: ControlsManifest = [
  { action: "go", input: "↑ / W", method: "keys" },
  { action: "stop", input: "↓ / S", method: "keys" },
  { action: "steer", input: "← →", method: "keys" },
  { action: "boost", input: "SHIFT", method: "keys" },
  { action: "map", input: "TAB", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "go", input: "HOLD", method: "touch" },
  { action: "steer", input: "DRAG", method: "touch" },
  { action: "stop · reverse", input: "BRAKE", method: "touch" },
  { action: "boost", input: "🔥", method: "touch" },
  { action: "go", input: "RT", method: "controller" },
  { action: "stop", input: "LT", method: "controller" },
  { action: "steer", input: "L-STICK", method: "controller" },
  { action: "boost", input: "B / RB", method: "controller" },
];

/** Group captions, in the game's clipped arcade register — shared by the
 *  landing banner and the pause overlay. */
export const METHOD_TAG = {
  camera: "CAM",
  controller: "PAD",
  keys: "KEYS",
  mouse: "MOUSE",
  touch: "TOUCH",
} satisfies Record<ControlMethod, string>;

/** Landing-banner keycap rows: just the verbs (no mute), grouped per visible
 *  input method under the pause overlay's KEYS/TOUCH/PAD tags. */
export const bannerControls = () => {
  const groups: { tag: string; hints: { keys: string[]; label: string }[] }[] = [];

  for (const group of controlGroups(CONTROLS)) {
    const hints: { keys: string[]; label: string }[] = [];

    for (const entry of group.entries) {
      if (entry.action === "mute") {
        continue;
      }

      hints.push({ keys: entry.input.split(" / "), label: entry.action });
    }

    if (hints.length > 0) {
      groups.push({ hints, tag: METHOD_TAG[group.method] });
    }
  }

  return groups;
};
