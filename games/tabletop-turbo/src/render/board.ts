import type * as THREE from "three";

import { MeshBuilder, FLAG, TEXTURED } from "../pixel/mesh-builder";
import { BASE, RAMP, tone } from "../pixel/palette";
import type { BoardMap, PixelStage } from "../pixel/stage";
import { CL, edgeDistance, holeDistance } from "../sim/arena";
import type { Arena, HazardDef } from "../sim/arena";

const TEXELS = 16;
const MARGIN = 0.5;

/** The desk the board stands on: how far a car falls before it is gone. */
export const TABLE_Y = -4.5;
const BORDER = 0.95;
const CELL = 0.2;

const CORE = 1;
const END = 2;

const hash = (a: number, b: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43_758.5453;

  return v - Math.floor(v);
};

const wrap = (v: number, period: number) => ((v % period) + period) % period;

const laneMark = (hazard: HazardDef, x: number, z: number) => {
  if (hazard.kind !== "piston") {
    return 0;
  }

  const fx = Math.cos(hazard.a);
  const fz = Math.sin(hazard.a);
  const along = (x - hazard.x) * fx + (z - hazard.z) * fz;
  const across = Math.abs(-(x - hazard.x) * fz + (z - hazard.z) * fx);

  if (along < 2.4 || along > hazard.reach + 1.5 || across > 2) {
    return 0;
  }

  if (across > 1.78) {
    return 1;
  }

  return wrap(along - across * 0.75, 2.4) < 0.55 && across < 1.45 ? 2 : 0;
};

const ringMark = (x: number, z: number, cx: number, cz: number, r: number, width: number) =>
  Math.abs(Math.hypot(x - cx, z - cz) - r) < width;

type Field = (x: number, z: number) => number;

const cross = (x0: number, z0: number, f0: number, x1: number, z1: number, f1: number) => {
  const t = f0 / (f0 - f1);

  return [x0 + (x1 - x0) * t, z0 + (z1 - z0) * t] as const;
};

const contour = (field: Field, halfX: number, halfZ: number) => {
  const runs: { ax: number; az: number; bx: number; bz: number; nx: number; nz: number }[] = [];

  for (let z = -halfZ - CELL; z < halfZ + CELL; z += CELL) {
    for (let x = -halfX - CELL; x < halfX + CELL; x += CELL) {
      const f = [field(x, z), field(x + CELL, z), field(x + CELL, z + CELL), field(x, z + CELL)];

      const corners = [
        [x, z],
        [x + CELL, z],
        [x + CELL, z + CELL],
        [x, z + CELL],
      ] as const;

      const cuts: (readonly [number, number])[] = [];

      for (let i = 0; i < 4; i += 1) {
        const j = (i + 1) % 4;
        const fi = f[i] ?? 0;
        const fj = f[j] ?? 0;
        const [xi, zi] = corners[i] ?? [0, 0];
        const [xj, zj] = corners[j] ?? [0, 0];

        if (fi > 0 !== fj > 0) {
          cuts.push(cross(xi, zi, fi, xj, zj, fj));
        }
      }

      for (let i = 0; i + 1 < cuts.length; i += 2) {
        const [ax, az] = cuts[i] ?? [0, 0];
        const [bx, bz] = cuts[i + 1] ?? [0, 0];
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        const gx = field(mx + 0.3, mz) - field(mx - 0.3, mz);
        const gz = field(mx, mz + 0.3) - field(mx, mz - 0.3);
        const length = Math.hypot(gx, gz) || 1;
        runs.push({ ax, az, bx, bz, nx: -gx / length, nz: -gz / length });
      }
    }
  }

  return runs;
};

const BANDS = [
  { from: 0, step: BASE + 2, to: 0.28 },
  { from: 0.28, step: BASE, to: 1.6 },
  { from: 1.6, step: BASE - 2, to: 1.74 },
  { from: 1.74, step: BASE - 1, to: 3.3 },
  { from: 3.3, step: BASE - 3, to: 3.44 },
  { from: 3.44, step: BASE - 2, to: -TABLE_Y },
] as const;

const wall = (b: MeshBuilder, field: Field, halfX: number, halfZ: number) => {
  b.part();

  for (const run of contour(field, halfX, halfZ)) {
    for (const band of BANDS) {
      b.quad(
        [run.ax, -band.from, run.az],
        [run.bx - run.ax, 0, run.bz - run.az],
        [0, band.from - band.to, 0],
        [run.nx, 0, run.nz],
        { tone: tone(RAMP.stone, band.step) },
      );
    }
  }
};

const PIPS = [
  [0, 0],
  [-0.3, -0.3],
  [0.3, 0.3],
  [-0.3, 0.3],
  [0.3, -0.3],
] as const;

const die = (b: MeshBuilder, x: number, z: number, yaw: number, pips: number) => {
  b.at(x, TABLE_Y, z, yaw).part();
  b.box(0, 0.6, 0, 1.2, 1.2, 1.2, {
    at: (px, py, pz) =>
      py > 1.15 && PIPS.slice(0, pips).some(([ox, oz]) => Math.hypot(px - ox, pz - oz) < 0.13)
        ? tone(RAMP.iron, BASE - 1)
        : -1,
    tone: tone(RAMP.cream, BASE + 1),
  });
};

const cone = (b: MeshBuilder, x: number, z: number) => {
  b.at(x, TABLE_Y, z).part();
  b.box(0, 0.08, 0, 1.5, 0.16, 1.5, { tone: tone(RAMP.orange, BASE - 1) });
  b.cone(0, 0.5, 0, 0.58, 0.4, 0.7, { tone: tone(RAMP.orange, BASE) });
  b.cone(0, 1.05, 0, 0.4, 0.28, 0.4, { tone: tone(RAMP.cream, BASE + 2) });
  b.cone(0, 1.55, 0, 0.28, 0.12, 0.6, { tone: tone(RAMP.orange, BASE) });
};

const pencil = (b: MeshBuilder, x: number, z: number, yaw: number, ramp: number) => {
  b.at(x, TABLE_Y, z, yaw).part();
  b.cylinder(0, 0.3, 0, 0.3, 7, { tone: tone(ramp, BASE) }, "x");
  b.part();
  b.cylinder(-3.9, 0.3, 0, 0.31, 0.8, { tone: tone(RAMP.steel, BASE + 1) }, "x");
  b.part();
  b.cylinder(-4.6, 0.3, 0, 0.3, 0.6, { tone: tone(RAMP.pink, BASE + 1) }, "x");
  b.part();
  b.cone(3.9, 0.3, 0, 0.3, 0.1, 0.8, { tone: tone(RAMP.cream, BASE) }, "x");
  b.cone(4.4, 0.3, 0, 0.1, 0.01, 0.2, { tone: tone(RAMP.iron, BASE - 2) }, "x");
};

const cards = (b: MeshBuilder, x: number, z: number, yaw: number) => {
  for (const [i, ramp] of [RAMP.blue, RAMP.red, RAMP.cream].entries()) {
    b.at(x + i * 0.35, TABLE_Y + i * 0.07, z - i * 0.25, yaw + i * 0.22).part();
    b.box(0, 0.035, 0, 2.2, 0.07, 3.2, {
      at: (px, _py, pz) =>
        Math.abs(px) > 0.92 || Math.abs(pz) > 1.42 ? tone(RAMP.white, BASE + 2) : -1,
      tone: tone(ramp, BASE),
    });
  }
};

const pot = (b: MeshBuilder, x: number, z: number, ramp: number) => {
  b.at(x, TABLE_Y, z).part();
  b.cylinder(0, 0.8, 0, 1.2, 1.6, {
    at: (_x, y) => (Math.abs(y - 0.8) < 0.3 ? tone(ramp, BASE) : -1),
    tone: tone(RAMP.steel, BASE + 1),
  });
  b.part();
  b.cylinder(0, 1.64, 0, 1.28, 0.12, { tone: tone(RAMP.steel, BASE + 2) });
  b.cylinder(0, 1.72, 0, 1.02, 0.06, { tone: tone(ramp, BASE + 1) });
};

const dress = (b: MeshBuilder, arena: Arena) => {
  const x = arena.halfX;
  const z = arena.halfZ;
  cone(b, -x - 2.6, -z - 1.4);
  cone(b, x + 2.8, -z + 2.2);
  cone(b, -x - 3, z - 3);
  cone(b, x + 2.4, z + 0.6);
  die(b, -x + 4, z + 4.2, 0.5, 5);
  die(b, -x + 6.2, z + 5.2, 1.1, 3);
  die(b, x + 3.4, -4, 0.2, 4);
  pencil(b, 6, -z - 4.6, 0.12, RAMP.yellow);
  pencil(b, -x - 5.4, 2, 1.45, RAMP.cyan);
  cards(b, x - 6, z + 5.4, 0.3);
  cards(b, -11, -z - 5.6, -0.4);
  pot(b, x + 4.2, 6, RAMP.red);
  pot(b, -x - 4.6, -8.5, RAMP.blue);
  pot(b, 14, -z - 4.8, RAMP.green);
  b.at(0, 0, 0);
};

export class Board {
  /** Everything that stays put. */
  readonly solids: THREE.BufferGeometry[];
  readonly map: BoardMap;
  private readonly endsTop: THREE.BufferGeometry;
  private readonly endsSides: THREE.BufferGeometry;
  private readonly arena: Arena;

  constructor(arena: Arena) {
    this.arena = arena;
    this.map = this.paint();
    const { halfX, halfZ } = arena;
    const core = new MeshBuilder();
    this.top(core, CORE);
    wall(core, (x, z) => edgeDistance(arena, x, z, true), halfX, halfZ);
    this.housePistons(core);
    const ends = new MeshBuilder();
    this.top(ends, END);
    this.endsTop = ends.build();
    const sides = new MeshBuilder();
    wall(
      sides,
      (x, z) => Math.min(edgeDistance(arena, x, z), -edgeDistance(arena, x, z, true)),
      halfX,
      halfZ,
    );
    this.floorPits(sides);
    this.endsSides = sides.build();
    this.solids = [core.build(), this.room()];
  }

  /** Put the ends on stage: `drop` is how far they have fallen, `flash` shows them lit up. */
  drawEnds(stage: PixelStage, drop: number, flash: boolean) {
    if (drop > 60) {
      return;
    }

    const place = { x: 0, y: -drop, yaw: 0, z: 0 };
    stage.draw(this.endsTop, { ...place, mono: flash, ramp: RAMP.hazard });
    stage.draw(this.endsSides, place);
  }

  private top(b: MeshBuilder, piece: number) {
    const { map } = this;
    b.part();
    b.quad(
      [map.x, 0, map.z],
      [0, 0, map.height / map.scale],
      [map.width / map.scale, 0, 0],
      [0, 1, 0],
      { tone: tone(TEXTURED, piece) },
    );
  }

  private tileAt(x: number, z: number, late: number) {
    const { arena } = this;
    const dropping = late <= 0;
    const ramp = dropping ? RAMP.stone : RAMP.tile;

    for (const hazard of arena.def.hazards) {
      const lane = laneMark(hazard, x, z);

      if (lane > 0) {
        return tone(lane === 1 ? RAMP.iron : RAMP.hazard, lane === 1 ? BASE + 1 : BASE);
      }

      const swept =
        hazard.kind === "sweeper" && ringMark(x, z, hazard.x, hazard.z, hazard.length + 0.8, 0.16);

      if (swept) {
        return tone(RAMP.red, BASE);
      }
    }

    for (const [px, pz] of [...arena.def.knockerPads, ...arena.def.carPads]) {
      const ax = Math.abs(x - px);
      const az = Math.abs(z - pz);
      const corner = Math.max(ax, az) < 2 && Math.max(ax, az) > 1.78 && Math.min(ax, az) > 1;

      if (corner || (ax < 0.1 && az < 0.5) || (az < 0.1 && ax < 0.5)) {
        return tone(RAMP.iron, BASE + 2);
      }
    }

    if (wrap(x, CL) < 0.09 || wrap(z, CL) < 0.09) {
      return tone(ramp, BASE - 1);
    }

    const fleck = hash(Math.floor(x * 5), Math.floor(z * 5));

    return tone(ramp, BASE + (dropping ? 0 : 1) - (fleck > 0.996 ? 1 : 0));
  }

  private texelAt(x: number, z: number, d: number) {
    const late = edgeDistance(this.arena, x, z, true);

    if (d < 0.1) {
      return tone(RAMP.cream, BASE + 2);
    }

    if (d < BORDER) {
      if (holeDistance(this.arena, x, z) > d + 0.01) {
        return tone(RAMP.iron, d < BORDER - 0.2 ? BASE + 1 : BASE - 1);
      }

      return wrap(x + z, 1.5) < 0.75 ? tone(RAMP.hazard, BASE) : tone(RAMP.iron, BASE);
    }

    if (d < BORDER + 0.1) {
      return tone(RAMP.iron, BASE - 1);
    }

    if (late > 0 && late < 0.36) {
      return wrap(x + z, 1.6) < 0.8 ? tone(RAMP.red, BASE) : tone(RAMP.cream, BASE + 1);
    }

    return this.tileAt(x, z, late);
  }

  private paint() {
    const { arena } = this;
    const x0 = -arena.halfX - MARGIN;
    const z0 = -arena.halfZ - MARGIN;
    const width = Math.ceil((arena.halfX + MARGIN) * 2 * TEXELS);
    const height = Math.ceil((arena.halfZ + MARGIN) * 2 * TEXELS);
    const bytes = new Uint8Array(width * height * 4);

    for (let j = 0; j < height; j += 1) {
      for (let i = 0; i < width; i += 1) {
        const x = x0 + (i + 0.5) / TEXELS;
        const z = z0 + (j + 0.5) / TEXELS;
        const d = edgeDistance(arena, x, z);

        if (d > 0) {
          const picked = this.texelAt(x, z, d);
          const o = (j * width + i) * 4;
          const ramp = Math.floor(picked / 8);
          const plain = ramp === RAMP.tile || ramp === RAMP.stone;
          bytes[o] = ramp;
          bytes[o + 1] = picked % 8;
          bytes[o + 2] = plain ? FLAG.floor : FLAG.floor + FLAG.flat;
          bytes[o + 3] = edgeDistance(arena, x, z, true) > 0 ? CORE : END;
        }
      }
    }

    return { bytes, height, scale: TEXELS, width, x: x0, z: z0 } satisfies BoardMap;
  }

  private floorPits(b: MeshBuilder) {
    b.part();

    for (const hole of this.arena.def.holes) {
      const hx = hole.kind === "box" ? hole.hx : hole.r;
      const hz = hole.kind === "box" ? hole.hz : hole.r;
      b.quad(
        [hole.x - hx, TABLE_Y + 0.04, hole.z - hz],
        [0, 0, hz * 2],
        [hx * 2, 0, 0],
        [0, 1, 0],
        { flags: FLAG.unlit + FLAG.noOutline, tone: tone(RAMP.iron, 0) },
      );
    }
  }

  private housePistons(b: MeshBuilder) {
    for (const hazard of this.arena.def.hazards) {
      if (hazard.kind === "piston") {
        b.at(hazard.x, 0, hazard.z, hazard.a).part();
        b.box(-0.6, 0.2, 0, 4.4, 3.2, 4.4, {
          at: (_x, y, z) => {
            if (Math.abs(Math.abs(z) - 1.9) < 0.12 || y > 1.5) {
              return tone(RAMP.iron, BASE + 1);
            }

            return wrap(y, 0.5) < 0.16 ? tone(RAMP.iron, BASE - 2) : -1;
          },
          tone: tone(RAMP.iron, BASE - 1),
        });
        b.part();
        b.box(-0.6, 1.95, 0, 4.7, 0.3, 4.7, {
          at: (x, _y, z) => (wrap(x + z, 1.2) < 0.6 ? tone(RAMP.iron, BASE - 1) : -1),
          tone: tone(RAMP.hazard, BASE),
        });
        b.part();
        b.box(1.5, 0.9, 0, 0.5, 1.5, 2.6, { tone: tone(RAMP.black, BASE - 1) });
      }
    }

    b.at(0, 0, 0);
  }

  private room() {
    const b = new MeshBuilder();
    b.part();
    b.quad([-110, TABLE_Y, -90], [0, 0, 190], [220, 0, 0], [0, 1, 0], {
      flags: FLAG.soft + FLAG.noShadow,
      tone: tone(RAMP.sand, BASE),
    });
    dress(b, this.arena);

    return b.build();
  }
}
