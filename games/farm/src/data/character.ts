// The farmer's animation clips: action -> frame count (encoded in the source
// strip name). Phaser-free, so the co-op wire format can validate clips too.
export const CHAR_FRAMES = {
  attack: 10,
  axe: 10,
  casting: 15,
  caught: 10,
  death: 13,
  dig: 13,
  doing: 8,
  hurt: 8,
  idle: 9,
  mine: 10,
  reeling: 13,
  run: 8,
  walk: 8,
  water: 5,
} as const;
export type CharAction = keyof typeof CHAR_FRAMES;
