/**
 * Properly-formed held input for a game page: KeyboardEvent inits that carry
 * `code`, `key` and `keyCode`, and PointerEvent dispatch in viewport
 * fractions. A port of the playtest skill's `scripts/lib/harness.mjs`, which
 * the scripted bot still uses; the two must agree on what a key looks like.
 *
 * NOT agent-browser's `keydown`/`keyup`: as of 0.34 those dispatch an event
 * with an empty `code` and `keyCode: 0`, which engines that match on keyCode
 * (Phaser among them) silently ignore. `press` populates the event correctly
 * but is a discrete tap, so it can't express a hold. Dispatching the event
 * ourselves is the only way to hold a properly-formed key. The tradeoff is
 * `isTrusted: false`, which matters only for games that check it.
 */

import { HarnessError } from "./errors.js";

/** `code` → `keyCode`, for codes whose keyCode isn't derivable from the name. */
const NAMED_KEYS = new Map<string, number>([
  ["AltLeft", 18],
  ["AltRight", 18],
  ["ArrowDown", 40],
  ["ArrowLeft", 37],
  ["ArrowRight", 39],
  ["ArrowUp", 38],
  ["Backquote", 192],
  ["Backslash", 220],
  ["Backspace", 8],
  ["BracketLeft", 219],
  ["BracketRight", 221],
  ["Comma", 188],
  ["ControlLeft", 17],
  ["ControlRight", 17],
  ["Delete", 46],
  ["Enter", 13],
  ["Equal", 187],
  ["Escape", 27],
  ["Minus", 189],
  ["Period", 190],
  ["Quote", 222],
  ["Semicolon", 186],
  ["ShiftLeft", 16],
  ["ShiftRight", 16],
  ["Slash", 191],
  ["Space", 32],
  ["Tab", 9],
]);

/** The `key` value a browser reports for a given `code`. */
const NAMED_VALUES = new Map<string, string>([
  ["AltLeft", "Alt"],
  ["AltRight", "Alt"],
  ["Backquote", "`"],
  ["Backslash", "\\"],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Comma", ","],
  ["ControlLeft", "Control"],
  ["ControlRight", "Control"],
  ["Equal", "="],
  ["Minus", "-"],
  ["Period", "."],
  ["Quote", "'"],
  ["Semicolon", ";"],
  ["ShiftLeft", "Shift"],
  ["ShiftRight", "Shift"],
  ["Slash", "/"],
  ["Space", " "],
]);

/**
 * What a US keyboard reports as `key` while Shift is held. The keyCodes above
 * already assume that layout, so this stays consistent with them.
 */
const SHIFTED = new Map<string, string>([
  ["Backquote", "~"],
  ["Backslash", "|"],
  ["BracketLeft", "{"],
  ["BracketRight", "}"],
  ["Comma", "<"],
  ["Digit0", ")"],
  ["Digit1", "!"],
  ["Digit2", "@"],
  ["Digit3", "#"],
  ["Digit4", "$"],
  ["Digit5", "%"],
  ["Digit6", "^"],
  ["Digit7", "&"],
  ["Digit8", "*"],
  ["Digit9", "("],
  ["Equal", "+"],
  ["Minus", "_"],
  ["Period", ">"],
  ["Quote", '"'],
  ["Semicolon", ":"],
  ["Slash", "?"],
]);

export const SUPPORTED_KEYS_HINT = `Key<A-Z>, Digit<0-9>, and ${[...NAMED_KEYS.keys()].join(", ")}`;

const shiftedKey = (code: string, key: string): string => {
  if (/^Key[A-Z]$/u.test(code)) {
    return key.toUpperCase();
  }
  return SHIFTED.get(code) ?? key;
};

/** `keyCode` and `key` for a KeyboardEvent `code`. Throws naming an unsupported code. */
export const keyFields = (code: string): [keyCode: number, key: string] => {
  const letter = /^Key(?<letter>[A-Z])$/u.exec(code)?.groups?.letter;
  if (letter) {
    return [letter.codePointAt(0) ?? 0, letter.toLowerCase()];
  }
  const digit = /^Digit(?<digit>[0-9])$/u.exec(code)?.groups?.digit;
  if (digit) {
    return [48 + Number(digit), digit];
  }
  // A Map, not an object: `in` on an object accepts inherited names, so
  // `toString` became a key with an undefined keyCode instead of a failure.
  const keyCode = NAMED_KEYS.get(code);
  if (keyCode !== undefined) {
    return [keyCode, NAMED_VALUES.get(code) ?? code];
  }
  throw new HarnessError(`unsupported key code "${code}". Supported: ${SUPPORTED_KEYS_HINT}.`);
};

const keyInits = (codes: string[]): string[] => {
  // Modifiers held together have to show up as flags on their companions
  // too, or `Shift+W` arrives as a plain `w` and the binding never fires.
  const modifiers = {
    altKey: codes.some((c) => c === "AltLeft" || c === "AltRight"),
    ctrlKey: codes.some((c) => c === "ControlLeft" || c === "ControlRight"),
    shiftKey: codes.some((c) => c === "ShiftLeft" || c === "ShiftRight"),
  };
  return codes.map((code) => {
    const [keyCode, key] = keyFields(code);
    const reported = modifiers.shiftKey ? shiftedKey(code, key) : key;
    return JSON.stringify({
      code,
      key: reported,
      keyCode,
      which: keyCode,
      ...modifiers,
      bubbles: true,
    });
  });
};

/**
 * In-page source pressing or releasing a set of keys — all of them in one
 * statement, since simultaneous keys should land together. Dispatched at the
 * focused element, not `window`: a real keypress starts there and bubbles up
 * through document to window, so listeners on all three fire once.
 */
export const keyParts = (type: "keydown" | "keyup", codes: string[]): string[] => {
  if (codes.length === 0) {
    return [];
  }
  return [
    `{ const t = document.activeElement ?? document.body ?? window;
      for (const init of [${keyInits(codes).join(",")}]) t.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, init)); }`,
  ];
};

/** A cursor position in viewport fractions, optionally with the primary button down. */
export interface Pointer {
  x: number;
  y: number;
  down?: boolean;
}

/**
 * Pointer dispatch, for games that steer from the cursor rather than the
 * keyboard. Both the PointerEvent and its MouseEvent twin go out: engines
 * listen for one or the other.
 */
const POINTER_FN = `window.__botPointer = (frac, type, buttons) => {
  const cx = Math.round(window.innerWidth * frac.x);
  const cy = Math.round(window.innerHeight * frac.y);
  const target = document.elementFromPoint(cx, cy) || document.querySelector("canvas") || window;
  const init = { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons };
  target.dispatchEvent(new PointerEvent(type, init));
  target.dispatchEvent(new MouseEvent(type === "pointermove" ? "mousemove" : type === "pointerdown" ? "mousedown" : "mouseup", init));
};`;

const pointerCall = (pointer: Pointer, type: string, buttons: number): string =>
  `window.__botPointer(${JSON.stringify({ x: pointer.x, y: pointer.y })}, ${JSON.stringify(type)}, ${buttons});`;

/** In-page source moving/pressing (`"down"`) or releasing (`"up"`) the cursor. */
export const pointerParts = (pointer: Pointer | null, phase: "down" | "up"): string[] => {
  if (!pointer) {
    return [];
  }
  const down = pointer.down === true;
  if (phase === "up") {
    return down ? [POINTER_FN, pointerCall(pointer, "pointerup", 0)] : [];
  }
  return [
    POINTER_FN,
    pointerCall(pointer, "pointermove", down ? 1 : 0),
    ...(down ? [pointerCall(pointer, "pointerdown", 1)] : []),
  ];
};

export const samePointer = (a: Pointer | null, b: Pointer | null): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
