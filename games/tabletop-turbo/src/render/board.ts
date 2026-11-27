import { CL, edgeDistance, inward } from "../sim/arena";
import type { Arena, HazardDef } from "../sim/arena";
import { SplatBuilder } from "../splat/builder";
import { RAMP } from "../splat/palette";
import { FLAG, SplatSet, tone } from "../splat/splat-set";

const SPACING = 0.26;
const SIDE_DEPTH = 2.6;
const ROOM_Y = -30;
const ROOM_SPACING = 1.5;
const EDGE = 0.55;

const FLOOR_RAMP = { bedroom: RAMP.board, kitchen: RAMP.felt, playroom: RAMP.carpet } as const;

const hash = (a: number, b: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43_758.5453;

  return v - Math.floor(v);
};

const wrap = (v: number, period: number) => ((v % period) + period) % period;

interface Dab {
  tone: number;
  flags: number;
}

const laneMark = (hazard: HazardDef, x: number, z: number) => {
  if (hazard.kind !== "piston") {
    return false;
  }

  const fx = Math.cos(hazard.a);
  const fz = Math.sin(hazard.a);
  const along = (x - hazard.x) * fx + (z - hazard.z) * fz;
  const across = Math.abs(-(x - hazard.x) * fz + (z - hazard.z) * fx);

  if (along < 0.8 || along > hazard.reach + 1.4 || across > 1.9) {
    return false;
  }

  return across > 1.55 || wrap(along - across * 0.8, 2.4) < 0.5;
};

const ringMark = (x: number, z: number, cx: number, cz: number, r: number, width: number) =>
  Math.abs(Math.hypot(x - cx, z - cz) - r) < width;

export class Board {
  /** Everything that stays put. */
  readonly set = new SplatSet(131_072);
  /** The two ends of the board, which drop away late in a round. */
  readonly ends = new SplatSet(32_768);
  private readonly arena: Arena;

  constructor(arena: Arena) {
    this.arena = arena;
    this.layTop();
    this.laySides(false);
    this.laySides(true);
    this.housePistons();
    this.layRoom();
  }

  /** Put the ends on stage: `drop` is how far they have fallen, `flash` shows them lit up. */
  drawEnds(out: SplatSet, drop: number, flash: boolean) {
    const { ends } = this;

    if (drop > 60) {
      return;
    }

    for (let i = 0; i < ends.count; i += 1) {
      const flags = ends.data[i * 4 + 3] ?? 0;
      const top = (ends.normals[i * 4 + 1] ?? 0) > 100;
      const ramp = ends.data[i * 4 + 1] ?? 0;
      const step = ends.data[i * 4 + 2] ?? 0;
      out.push(
        ends.centers[i * 3] ?? 0,
        (ends.centers[i * 3 + 1] ?? 0) - drop,
        ends.centers[i * 3 + 2] ?? 0,
        (ends.normals[i * 4] ?? 0) / 127,
        (ends.normals[i * 4 + 1] ?? 0) / 127,
        (ends.normals[i * 4 + 2] ?? 0) / 127,
        (ends.data[i * 4] ?? 0) / 100,
        flash && top ? tone(RAMP.hazard, Math.min(4, step + 1)) : tone(ramp, step),
        flash && top ? FLAG.unlit : flags,
      );
    }
  }

  private topAt(x: number, z: number, d: number) {
    const { arena } = this;

    if (d < EDGE) {
      return { flags: FLAG.unlit, tone: tone(RAMP.cream, 3) } satisfies Dab;
    }

    if (d < EDGE + 0.3) {
      return { flags: FLAG.paintable, tone: tone(FLOOR_RAMP[arena.def.room], 0) } satisfies Dab;
    }

    const late = edgeDistance(arena, x, z, true);

    if (late > 0 && late < 0.4 && wrap(x + z, 2.4) < 1.2) {
      return { flags: FLAG.bright, tone: tone(RAMP.cream, 2) } satisfies Dab;
    }

    for (const hazard of arena.def.hazards) {
      if (laneMark(hazard, x, z)) {
        return { flags: FLAG.paintable, tone: tone(RAMP.hazard, 2) } satisfies Dab;
      }

      const swept =
        hazard.kind === "sweeper" && ringMark(x, z, hazard.x, hazard.z, hazard.length + 0.7, 0.3);

      if (swept && wrap(Math.atan2(z - hazard.z, x - hazard.x), Math.PI / 10) < Math.PI / 16) {
        return { flags: FLAG.paintable, tone: tone(RAMP.hazard, 2) } satisfies Dab;
      }
    }

    for (const [px, pz] of [...arena.def.knockerPads, ...arena.def.carPads]) {
      if (ringMark(x, z, px, pz, 1.9, 0.2)) {
        return { flags: FLAG.paintable, tone: tone(RAMP.cream, 2) } satisfies Dab;
      }
    }

    const ramp = FLOOR_RAMP[arena.def.room];
    const dark = (Math.floor(x / (2 * CL) + 100) + Math.floor(z / (2 * CL) + 100)) % 2 === 0;
    const fleck = hash(Math.floor(x * 2.2), Math.floor(z * 2.2));
    let step = dark ? 1 : 2;

    if (fleck > 0.975) {
      step += 1;
    }

    return { flags: FLAG.paintable, tone: tone(ramp, step) } satisfies Dab;
  }

  private layTop() {
    const { arena } = this;
    const main = new SplatBuilder(SPACING, this.set, 21);
    const ends = new SplatBuilder(SPACING, this.ends, 22);

    for (let z = -arena.halfZ; z <= arena.halfZ; z += SPACING) {
      for (let x = -arena.halfX; x <= arena.halfX; x += SPACING) {
        const px = x + (main.random() - 0.5) * 0.1;
        const pz = z + (main.random() - 0.5) * 0.1;
        const d = edgeDistance(arena, px, pz);

        if (d > 0) {
          const b = edgeDistance(arena, px, pz, true) > 0 ? main : ends;
          b.dab(px, 0, pz, 0, 1, 0, this.topAt(px, pz, d));
        }
      }
    }
  }

  private laySides(late: boolean) {
    const { arena } = this;
    const main = new SplatBuilder(SPACING, this.set, 31);
    const ends = new SplatBuilder(SPACING, this.ends, 32);
    const rows = Math.ceil(SIDE_DEPTH / SPACING);

    for (let z = -arena.halfZ; z <= arena.halfZ; z += SPACING) {
      for (let x = -arena.halfX; x <= arena.halfX; x += SPACING) {
        const d = edgeDistance(arena, x, z, late);
        const kept = edgeDistance(arena, x, z, true) > 0;
        const inner = late && edgeDistance(arena, x, z) > 0.4;

        if (d > 0 && d <= SPACING * 1.2 && (late ? inner : true)) {
          const n = inward(arena, x, z, late);
          const b = late || kept ? main : ends;
          const ex = x - n.x * d;
          const ez = z - n.z * d;

          for (let row = 0; row <= rows; row += 1) {
            const step = row === 0 ? 3 : 2 - (row > rows * 0.6 ? 1 : 0);
            b.dab(ex, -0.12 - row * SPACING, ez, -n.x, 0, -n.z, { tone: tone(RAMP.wood, step) });
          }
        }
      }
    }
  }

  private housePistons() {
    const b = new SplatBuilder(0.3, this.set, 41);

    for (const hazard of this.arena.def.hazards) {
      if (hazard.kind === "piston") {
        b.at(hazard.x, 0, hazard.z, hazard.a);
        b.box(-1.5, -0.3, 0, 2.6, 3.4, 4, {
          at: (x, y, z) => (wrap(y + z * 0.9, 1.4) < 0.7 && x > -2.7 ? tone(RAMP.black, 1) : -1),
          flags: FLAG.bright,
          tone: tone(RAMP.hazard, 2),
        });
      }
    }
  }

  private layRoom() {
    const b = new SplatBuilder(ROOM_SPACING, this.set, 51);

    for (let z = -70; z < 80; z += ROOM_SPACING) {
      for (let x = -90; x < 90; x += ROOM_SPACING) {
        const row = Math.floor(z / 4.2);
        const along = x + row * 9.1;
        const seam = wrap(z, 4.2) < 1.5 || wrap(along, 23) < 1.5;
        const step = hash(row, Math.floor(along / 23)) > 0.5 ? 2 : 1;
        b.dab(x, ROOM_Y, z, 0, 1, 0, { tone: tone(RAMP.room, seam ? 1 : step + 1) });
      }
    }
  }
}
