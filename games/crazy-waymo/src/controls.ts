import { controlGroups } from "@repo/embed";
import type { ControlsManifest } from "@repo/embed";

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

/** Landing-banner keycap rows: just the verbs (no mute), inputs for the same
 *  verb merged into one chip group across visible methods. */
export function bannerControls(): { keys: string[]; label: string }[] {
  const rows = new Map<string, string[]>();
  for (const group of controlGroups(CONTROLS)) {
    for (const entry of group.entries) {
      if (entry.action === "mute") continue;
      const keys = rows.get(entry.action) ?? [];
      for (const key of entry.input.split(" / ")) if (!keys.includes(key)) keys.push(key);
      rows.set(entry.action, keys);
    }
  }
  return Array.from(rows, ([label, keys]) => ({ keys, label }));
}
