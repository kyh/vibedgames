import { activeMethods } from "@repo/embed";
import type { ControlEntry, ControlMethod, ControlsManifest } from "@repo/embed";

// Every way to play, one list — the title legend and the pause overlay both
// render from this (filtered per device / connected pad by @repo/embed).
// Camera rows include every existing gesture; titleSubText keeps two headlines.
export const CONTROLS: ControlsManifest = [
  { action: "move", input: "←→↑↓", method: "keys" },
  { action: "rotate", input: "R", method: "keys" },
  { action: "turn view", input: "Q / E", method: "keys" },
  { action: "hard drop", input: "SPACE", method: "keys" },
  { action: "soft drop", input: "SHIFT", method: "keys" },
  { action: "hold piece", input: "C", method: "keys" },
  { action: "power sweep", input: "F", method: "keys" },
  { action: "recenter", input: "V", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "pause", input: "P", method: "keys" },
  { action: "move", input: "DRAG", method: "touch" },
  { action: "rotate", input: "ROT", method: "touch" },
  { action: "turn view", input: "↺ ↻", method: "touch" },
  { action: "hard drop", input: "DROP tap", method: "touch" },
  { action: "soft drop", input: "DROP hold", method: "touch" },
  { action: "hold piece", input: "HOLD", method: "touch" },
  { action: "power sweep", input: "PWR", method: "touch" },
  { action: "move", input: "📷 lean", method: "camera" },
  { action: "rotate", input: "📷 twist", method: "camera" },
  { action: "power sweep", input: "📷 T-pose", method: "camera" },
  { action: "turn view", input: "📷 circle raised hand", method: "camera" },
  { action: "hold piece", input: "📷 cross wrists", method: "camera" },
  { action: "start / catch collapse", input: "📷 throw hands up", method: "camera" },
  { action: "move", input: "L-STICK / D-PAD", method: "controller" },
  { action: "rotate", input: "A", method: "controller" },
  { action: "turn view", input: "LB / RB", method: "controller" },
  { action: "hard drop", input: "B", method: "controller" },
  { action: "soft drop", input: "LT / RT", method: "controller" },
  { action: "hold piece", input: "X", method: "controller" },
  { action: "power sweep", input: "Y", method: "controller" },
  { action: "pause", input: "START", method: "controller" },
];

/** Display name per input method — shared by the title legend and the pause
 *  overlay so every instruction surface speaks the same words. */
export const METHOD_LABEL = {
  camera: "webcam",
  controller: "pad",
  keys: "keys",
  mouse: "mouse",
  touch: "touch",
} satisfies Record<ControlMethod, string>;

const say = (entry: ControlEntry): string => `${entry.input} to ${entry.action}`;

const startHint = (methods: ReadonlySet<ControlMethod>): string => {
  if (methods.has("controller")) {
    return "any button to start";
  }
  if (methods.has("touch")) {
    return "tap to start";
  }
  return "Enter / Space to start";
};

/** Title-banner sub line: the headline verbs plus how to start.
 *
 *  The floating stick draws nothing until a finger lands and the labelled
 *  buttons cover every verb except movement, so on touch the drag row takes the
 *  lead — it is the only control a phone player has no other way to discover,
 *  and on a landscape phone this line is the whole reference (the legend has no
 *  room). Everywhere else the two headline camera gestures lead. */
export const titleSubText = (): string => {
  const methods = activeMethods();
  const camera = CONTROLS.filter((entry) => entry.method === "camera");
  const drag = CONTROLS.find((entry) => entry.method === "touch" && entry.action === "move");
  const headline = (
    methods.has("touch") && drag ? [drag, ...camera.slice(1, 2)] : camera.slice(0, 2)
  ).map(say);
  return [...headline, startHint(methods)].join(" · ");
};
