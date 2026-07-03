// Hand-placed map decorations, authored with the in-game editor:
// open the game with `?editor=1`, place assets, hit "Copy JSON", and paste
// the array below (replace the whole array). Coordinates are normalized
// (u = west→east 0..1, v = north→south 0..1) so grid rescales don't move them.

export type CustomProp = {
  readonly model: string; // "category/name" under public/models/
  readonly u: number;
  readonly v: number;
  readonly yaw: number; // radians
  readonly s: number; // uniform scale
  readonly solid?: boolean; // give it a collision box
};

export const CUSTOM_PROPS: readonly CustomProp[] = [];
