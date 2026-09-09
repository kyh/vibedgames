import { controlGroups } from "@repo/embed";
import type { ControlMethod, ControlsManifest } from "@repo/embed";

import { handCameraState } from "./input/camera";

// Every way to play, one list — the serve/rematch banner and the pause overlay
// both render from this (filtered per device / connected pad by @repo/embed).
// Drag-to-pan is deliberately absent: a gimmick left to be discovered.
export const CONTROLS: ControlsManifest = [
  { action: "mute", input: "M", method: "keys" },
  { action: "steer the paddle", input: "MOUSE", method: "mouse" },
  { action: "serve · rematch", input: "CLICK", method: "mouse" },
  { action: "steer the paddle", input: "FINGER", method: "touch" },
  { action: "serve · rematch", input: "TAP", method: "touch" },
  { action: "mute", input: "🔊", method: "touch" },
  { action: "steer the paddle", input: "✋ HAND", method: "camera" },
  { action: "serve · rematch", input: "✊ FIST", method: "camera" },
  { action: "steer the paddle", input: "STICK", method: "controller" },
  { action: "serve · rematch", input: "A", method: "controller" },
];

/** The manifest as it applies right now. @repo/embed shows camera rows on
 *  every device — right in general (the webcam works on both platforms), wrong
 *  here: pong's tracking is opt-in on touch and simply unavailable when the
 *  camera is denied, and copy that leads with ✋/✊ on a device where they do
 *  nothing is worse than no copy at all. */
export const visibleControls = (): ControlsManifest => {
  if (handCameraState() === "live") {
    return CONTROLS;
  }
  return CONTROLS.filter((entry) => entry.method !== "camera");
};

// Banner prose leads with the gestures (pong is hand-gesture first), even
// though list surfaces (pause overlay) keep the standard method order.
const SENTENCE_ORDER: readonly ControlMethod[] = ["camera", "mouse", "touch", "keys", "controller"];

/** One piece of a banner line: either a bare prose run or an input word the
 *  banner renders as the pause card's ink keycap chip. */
export type PromptSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "chip"; readonly text: string };

/** A run that must stay on one line: "[✊ FIST] or [TAP] serves" reads as
 *  nonsense split across a wrap, so phrases are the unit banners lay out. */
export type PromptPhrase = readonly PromptSegment[];

/** The visible inputs for one action, sentence-ordered and deduped — the
 *  words the banner turns into keycap chips ("✋ HAND", "MOUSE"). Casing stays
 *  the manifest's, matching the pause overlay's chips. */
const inputWords = (action: string): string[] => {
  const byMethod = new Map<ControlMethod, string[]>();
  for (const group of controlGroups(visibleControls())) {
    for (const entry of group.entries) {
      if (entry.action !== action) {
        continue;
      }
      const inputs = byMethod.get(group.method) ?? [];
      inputs.push(entry.input);
      byMethod.set(group.method, inputs);
    }
  }
  const words: string[] = [];
  for (const method of SENTENCE_ORDER) {
    for (const input of byMethod.get(method) ?? []) {
      if (!words.includes(input)) {
        words.push(input);
      }
    }
  }
  return words;
};

/** Chips joined by prose "or", then a trailing verb: [✋ HAND] or [MOUSE] steers. */
const chipPhrase = (action: string, verb: string): PromptPhrase => {
  const segments: PromptSegment[] = [];
  for (const word of inputWords(action)) {
    if (segments.length > 0) {
      segments.push({ kind: "text", text: " or " });
    }
    segments.push({ kind: "chip", text: word });
  }
  segments.push({ kind: "text", text: verb });
  return segments;
};

/** Serve-banner line: "[✋ HAND] or [MOUSE] steers · [✊ FIST] or [CLICK] serves". */
export const servePromptPhrases = (): PromptPhrase[] => [
  chipPhrase("steer the paddle", " steers"),
  chipPhrase("serve · rematch", " serves"),
];

/** Win-banner note: "[✊ FIST] or [CLICK] for rematch". */
export const rematchNotePhrases = (): PromptPhrase[] => [
  chipPhrase("serve · rematch", " for rematch"),
];

/** Handshake note: the wait is not a dead end — "finding a match… · [TAP] to
 *  play solo". */
export const connectingPromptPhrases = (): PromptPhrase[] => [
  [{ kind: "text", text: "finding a match…" }],
  chipPhrase("serve · rematch", " to play solo"),
];
