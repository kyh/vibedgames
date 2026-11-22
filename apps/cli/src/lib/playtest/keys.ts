import { HarnessError } from "./errors.js";

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

const shiftedKey = (code: string, key: string) => {
  if (/^Key[A-Z]$/u.test(code)) {
    return key.toUpperCase();
  }

  return SHIFTED.get(code) ?? key;
};

/** `keyCode` and `key` for a KeyboardEvent `code`. Throws naming an unsupported code. */
export const keyFields: (code: string) => [keyCode: number, key: string] = (code) => {
  const letter = /^Key(?<letter>[A-Z])$/u.exec(code)?.groups?.letter;

  if (letter) {
    return [letter.codePointAt(0) ?? 0, letter.toLowerCase()];
  }

  const digit = /^Digit(?<digit>[0-9])$/u.exec(code)?.groups?.digit;

  if (digit) {
    return [48 + Number(digit), digit];
  }

  const keyCode = NAMED_KEYS.get(code);

  if (keyCode !== undefined) {
    return [keyCode, NAMED_VALUES.get(code) ?? code];
  }

  throw new HarnessError(`unsupported key code "${code}". Supported: ${SUPPORTED_KEYS_HINT}.`);
};

/** A properly-formed KeyboardEventInit for `code`, with modifier flags. */
export interface KeyInit {
  code: string;
  key: string;
  keyCode: number;
  which: number;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  bubbles: true;
}

const modifiersOf = (codes: string[]) => ({
  altKey: codes.some((c) => c === "AltLeft" || c === "AltRight"),
  ctrlKey: codes.some((c) => c === "ControlLeft" || c === "ControlRight"),
  shiftKey: codes.some((c) => c === "ShiftLeft" || c === "ShiftRight"),
});

/**
 * Inits for a set of keys held together. Modifiers held in the same set show
 * up as flags on their companions too, or `Shift+W` arrives as a plain `w`
 * and the binding a scheme was written to exercise never fires.
 */
export const keyInitsFor: (codes: string[]) => KeyInit[] = (codes) => {
  const modifiers = modifiersOf(codes);

  return codes.map((code) => {
    const [keyCode, key] = keyFields(code);

    return {
      bubbles: true,
      code,
      key: modifiers.shiftKey ? shiftedKey(code, key) : key,
      keyCode,
      which: keyCode,
      ...modifiers,
    };
  });
};

/** Every supported code, each as if pressed alone — for inputs a reflex returns by code. */
export const keyTable = () => {
  const codes = [
    ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCodePoint(65 + i)}`),
    ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
    ...NAMED_KEYS.keys(),
  ];

  const table: Record<string, KeyInit> = {};

  for (const code of codes) {
    const [init] = keyInitsFor([code]);

    if (init) {
      table[code] = init;
    }
  }

  return table;
};

/** A cursor position in viewport fractions, optionally with the primary button down. */
export interface Pointer {
  x: number;
  y: number;
  down?: boolean;
}
