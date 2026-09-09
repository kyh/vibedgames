// Hand-placed map decorations, authored with the in-game editor:
// open the game with `?editor=1`, place assets, hit "Copy JSON", and paste
// the array below (replace the whole array). Coordinates are normalized
// (u = west→east 0..1, v = north→south 0..1) so grid rescales don't move them.

export interface CustomProp {
  // "category/name" under public/models/
  readonly model: string;
  readonly u: number;
  readonly v: number;
  // radians
  readonly yaw: number;
  // uniform scale
  readonly s: number;
  // give it a collision box
  readonly solid?: boolean;
}

export const CUSTOM_PROPS: readonly CustomProp[] = [];
