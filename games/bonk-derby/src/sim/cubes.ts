import { CUBES_AT, CUBE_BEAM, CUBE_EVERY, ROUND_MS } from "../shared/constants";
import { edgeDistance } from "./arena";
import type { Arena } from "./arena";

/** A power cube: on its pad, or on its way down to it. */
export interface Cube {
  /** The same on every client: which pad, and which of that pad's cubes. */
  id: number;
  x: number;
  z: number;
  /** Seconds into the round it lands; the beam shows from `CUBE_BEAM` before. */
  landAt: number;
}

const firstAt = (pad: number) => CUBES_AT + ((pad * 0.618) % 1) * CUBE_EVERY;

/**
 * Every cube on the board (or on its way down) at `time` seconds into the
 * round: one a pad, each replaced by the next on a clock every client can work
 * out. `late` is the board with its rim gone, and its pads with it.
 */
export const cubesAt = (arena: Arena, time: number, late: boolean) => {
  const out: Cube[] = [];

  if (time * 1000 >= ROUND_MS) {
    return out;
  }

  for (const [pad, [x, z]] of arena.def.pads.entries()) {
    const first = firstAt(pad);
    const n = Math.floor((time - first + CUBE_BEAM) / CUBE_EVERY);

    if (n >= 0 && (!late || edgeDistance(arena, x, z, true) > 0)) {
      out.push({ id: pad * 100 + n, landAt: first + n * CUBE_EVERY, x, z });
    }
  }

  return out;
};
