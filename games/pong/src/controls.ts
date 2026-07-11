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

/** The visible inputs for one action as prose ("✋ hand or mouse"). Multi-letter
 *  inputs read as words and lowercase; single letters are button names ("A"). */
function inputPhrase(action: string): string {
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
      const word = input.length === 1 ? input : input.toLowerCase();
      if (!words.includes(word)) words.push(word);
    }
  }
  return words.join(" or ");
}

/** Serve-banner line: "✋ hand or mouse steers · ✊ fist or click serves". */
export function servePromptText(): string {
  return `${inputPhrase("steer the paddle")} steers · ${inputPhrase("serve · rematch")} serves`;
}

/** Win-banner note: "✊ fist or click for rematch". */
export function rematchNoteText(): string {
  return `${inputPhrase("serve · rematch")} for rematch`;
}
