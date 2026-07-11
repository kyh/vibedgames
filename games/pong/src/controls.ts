import { controlGroups } from "@repo/embed";
import type { ControlMethod, ControlsManifest } from "@repo/embed";

// Every way to play, one list — the serve/rematch banner and the pause overlay
// both render from this (filtered per device / connected pad by @repo/embed).
// Drag-to-pan is deliberately absent: a gimmick left to be discovered.
export const CONTROLS: ControlsManifest = [
  { method: "keys", input: "M", action: "mute" },
  { method: "mouse", input: "MOUSE", action: "steer the paddle" },
  { method: "mouse", input: "CLICK", action: "serve · rematch" },
  { method: "touch", input: "FINGER", action: "steer the paddle" },
  { method: "touch", input: "TAP", action: "serve · rematch" },
  { method: "camera", input: "✋ HAND", action: "steer the paddle" },
  { method: "camera", input: "✊ FIST", action: "serve · rematch" },
  { method: "controller", input: "STICK", action: "steer the paddle" },
  { method: "controller", input: "A", action: "serve · rematch" },
];

// Banner prose leads with the gestures (pong is hand-gesture first), even
// though list surfaces (pause overlay) keep the standard method order.
const SENTENCE_ORDER: readonly ControlMethod[] = ["camera", "mouse", "touch", "keys", "controller"];

/** One piece of a banner line: either a bare prose run or an input word the
 *  banner renders as the pause card's ink keycap chip. */
export type PromptSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "chip"; readonly text: string };

/** The visible inputs for one action, sentence-ordered and deduped — the
 *  words the banner turns into keycap chips ("✋ HAND", "MOUSE"). Casing stays
 *  the manifest's, matching the pause overlay's chips. */
function inputWords(action: string): string[] {
  const byMethod = new Map<ControlMethod, string[]>();
  for (const group of controlGroups(CONTROLS)) {
    for (const entry of group.entries) {
      if (entry.action !== action) continue;
      const inputs = byMethod.get(group.method) ?? [];
      inputs.push(entry.input);
      byMethod.set(group.method, inputs);
    }
  }
  const words: string[] = [];
  for (const method of SENTENCE_ORDER) {
    for (const input of byMethod.get(method) ?? []) {
      if (!words.includes(input)) words.push(input);
    }
  }
  return words;
}

/** Chips joined by prose "or": [✋ HAND] or [MOUSE]. */
function chipPhrase(action: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  for (const word of inputWords(action)) {
    if (segments.length > 0) segments.push({ kind: "text", text: " or " });
    segments.push({ kind: "chip", text: word });
  }
  return segments;
}

/** Serve-banner line: "[✋ HAND] or [MOUSE] steers · [✊ FIST] or [CLICK] serves". */
export function servePromptSegments(): PromptSegment[] {
  return [
    ...chipPhrase("steer the paddle"),
    { kind: "text", text: " steers · " },
    ...chipPhrase("serve · rematch"),
    { kind: "text", text: " serves" },
  ];
}

/** Win-banner note: "[✊ FIST] or [CLICK] for rematch". */
export function rematchNoteSegments(): PromptSegment[] {
  return [...chipPhrase("serve · rematch"), { kind: "text", text: " for rematch" }];
}
