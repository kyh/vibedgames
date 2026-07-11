import { controlGroups } from "@repo/embed";
import type { ControlMethod, ControlsManifest } from "@repo/embed";

// Every way to drive, one list — the landing banner and the pause overlay
// both render from this (filtered per device / connected pad by @repo/embed).
// Drift, restart and chat are deliberately absent: left to be discovered.
export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "↑ / W", action: "go" },
  { method: "keys", input: "↓ / S", action: "stop" },
  { method: "keys", input: "← →", action: "steer" },
  { method: "keys", input: "SHIFT", action: "boost" },
  { method: "keys", input: "M", action: "mute" },
  { method: "touch", input: "HOLD", action: "go" },
  { method: "touch", input: "DRAG", action: "steer" },
  { method: "touch", input: "BRAKE", action: "stop · reverse" },
  { method: "touch", input: "🔥", action: "boost" },
  { method: "controller", input: "RT", action: "go" },
  { method: "controller", input: "LT", action: "stop" },
  { method: "controller", input: "L-STICK", action: "steer" },
  { method: "controller", input: "B / RB", action: "boost" },
];

/** Group captions, in the game's clipped arcade register — shared by the
 *  landing banner and the pause overlay. */
export const METHOD_TAG: Record<ControlMethod, string> = {
  keys: "KEYS",
  mouse: "MOUSE",
  touch: "TOUCH",
  camera: "CAM",
  controller: "PAD",
};

/** Landing-banner keycap rows: just the verbs (no mute), grouped per visible
 *  input method under the pause overlay's KEYS/TOUCH/PAD tags. */
export function bannerControls(): { tag: string; hints: { keys: string[]; label: string }[] }[] {
  const groups: { tag: string; hints: { keys: string[]; label: string }[] }[] = [];
  for (const group of controlGroups(CONTROLS)) {
    const hints: { keys: string[]; label: string }[] = [];
    for (const entry of group.entries) {
      if (entry.action === "mute") continue;
      hints.push({ keys: entry.input.split(" / "), label: entry.action });
    }
    if (hints.length > 0) groups.push({ tag: METHOD_TAG[group.method], hints });
  }
  return groups;
}
