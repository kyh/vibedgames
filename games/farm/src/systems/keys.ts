import Phaser from "phaser";

type K = Phaser.Input.Keyboard.Key;
type Plugin = Phaser.Input.Keyboard.KeyboardPlugin;

// Typed key bundles so accessing a named key is a Key, not Key | undefined
// (which noUncheckedIndexedAccess would give for a string-indexed Record).

export type GameKeys = {
  W: K;
  A: K;
  S: K;
  D: K;
  UP: K;
  DOWN: K;
  LEFT: K;
  RIGHT: K;
  SPACE: K;
  E: K;
  SHIFT: K;
  I: K;
  H: K;
  M: K;
  ONE: K;
  TWO: K;
  THREE: K;
  FOUR: K;
  FIVE: K;
  SIX: K;
  SEVEN: K;
  EIGHT: K;
  NINE: K;
  ZERO: K;
};

// The mine has no inventory/help/mute bindings; a GameKeys is structurally a
// MineKeys, so MineScene reuses makeGameKeys.
export type MineKeys = Omit<GameKeys, "I" | "H" | "M">;

const NUMS = [
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
  "SIX",
  "SEVEN",
  "EIGHT",
  "NINE",
  "ZERO",
] as const;
export type NumKeyName = (typeof NUMS)[number];
export const NUM_KEY_NAMES: readonly NumKeyName[] = NUMS;

export function makeGameKeys(kb: Plugin): GameKeys {
  const a = (n: string): K => kb.addKey(n, false);
  return {
    W: a("W"),
    A: a("A"),
    S: a("S"),
    D: a("D"),
    UP: a("UP"),
    DOWN: a("DOWN"),
    LEFT: a("LEFT"),
    RIGHT: a("RIGHT"),
    SPACE: a("SPACE"),
    E: a("E"),
    SHIFT: a("SHIFT"),
    I: a("I"),
    H: a("H"),
    M: a("M"),
    ONE: a("ONE"),
    TWO: a("TWO"),
    THREE: a("THREE"),
    FOUR: a("FOUR"),
    FIVE: a("FIVE"),
    SIX: a("SIX"),
    SEVEN: a("SEVEN"),
    EIGHT: a("EIGHT"),
    NINE: a("NINE"),
    ZERO: a("ZERO"),
  };
}
