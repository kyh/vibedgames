import type Phaser from "phaser";

type K = Phaser.Input.Keyboard.Key;
type Plugin = Phaser.Input.Keyboard.KeyboardPlugin;

// Typed key bundles so accessing a named key is a Key, not Key | undefined
// (which noUncheckedIndexedAccess would give for a string-indexed Record).

export interface GameKeys {
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
}

// The mine has no inventory/mute bindings; a GameKeys is structurally a
// MineKeys, so MineScene reuses makeGameKeys.
export type MineKeys = Omit<GameKeys, "I" | "M">;

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

export const makeGameKeys = (kb: Plugin): GameKeys => {
  const a = (n: string): K => kb.addKey(n, false);
  return {
    A: a("A"),
    D: a("D"),
    DOWN: a("DOWN"),
    E: a("E"),
    EIGHT: a("EIGHT"),
    FIVE: a("FIVE"),
    FOUR: a("FOUR"),
    I: a("I"),
    LEFT: a("LEFT"),
    M: a("M"),
    NINE: a("NINE"),
    ONE: a("ONE"),
    RIGHT: a("RIGHT"),
    S: a("S"),
    SEVEN: a("SEVEN"),
    SHIFT: a("SHIFT"),
    SIX: a("SIX"),
    SPACE: a("SPACE"),
    THREE: a("THREE"),
    TWO: a("TWO"),
    UP: a("UP"),
    W: a("W"),
    ZERO: a("ZERO"),
  };
};
