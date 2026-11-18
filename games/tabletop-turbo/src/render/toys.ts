// The things a toy track gets built between: alphabet blocks, stacked books,
// balls, crayons, cones, bricks, a rubber duck. All of them oversized next to
// the karts, which is what makes the karts read as toys.
//
// Each toy bakes itself around the origin of a builder already placed and
// turned; `reach` is how far it spreads, so the world can keep it off the road.

import type { SplatBuilder } from "../splat/builder";
import { RAMP } from "../splat/palette";
import { tone } from "../splat/splat-set";

export interface Toy {
  reach: number;
  bake: (b: SplatBuilder) => void;
}

const BRIGHTS = [RAMP.red, RAMP.yellow, RAMP.blue, RAMP.green, RAMP.pink, RAMP.cyan] as const;

const bright = (b: SplatBuilder): number =>
  BRIGHTS[Math.floor(b.random() * BRIGHTS.length)] ?? RAMP.red;

/** An alphabet block: a cube with a lighter frame on every face. */
const block = (b: SplatBuilder, size: number, ramp: number, y = 0): void => {
  const rim = size * 0.36;
  b.box(0, y + size / 2, 0, size, size, size, {
    at: (x, py, z) => {
      const edges = [Math.abs(x), Math.abs(py - y - size / 2), Math.abs(z)].filter(
        (v) => v > rim,
      ).length;
      return edges >= 2 ? tone(ramp, 3) : -1;
    },
    tone: tone(ramp, 2),
  });
};

const blocks: Toy = {
  bake: (b) => {
    const size = 2.6 + b.random() * 1.2;
    block(b, size, bright(b));
    if (b.random() > 0.45) {
      block(b, size * 0.8, bright(b), size);
    }
  },
  reach: 3,
};

const books: Toy = {
  bake: (b) => {
    let y = 0;
    const count = 2 + Math.floor(b.random() * 3);
    for (let i = 0; i < count; i += 1) {
      const ramp = bright(b);
      const thick = 1.2 + b.random() * 0.8;
      const dx = (b.random() - 0.5) * 1.2;
      // Pages between two covers.
      b.box(dx, y + thick / 2, 0, 9.4, thick - 0.4, 6.4, { tone: tone(RAMP.white, 3) });
      b.box(dx, y + thick - 0.1, 0, 9.8, 0.2, 6.8, { tone: tone(ramp, 2) });
      b.box(dx - 4.8, y + thick / 2, 0, 0.3, thick, 6.8, { tone: tone(ramp, 1) });
      y += thick;
    }
  },
  reach: 6.5,
};

const ball: Toy = {
  bake: (b) => {
    const r = 2 + b.random() * 1.6;
    const first = bright(b);
    b.sphere(0, r, 0, r, {
      // Beach-ball panels.
      at: (x, _y, z) => {
        const panel = Math.floor(((Math.atan2(z, x) + Math.PI) / Math.PI) * 3);
        return panel % 2 === 0 ? tone(RAMP.white, 3) : -1;
      },
      tone: tone(first, 2),
    });
  },
  reach: 3.8,
};

const crayon: Toy = {
  bake: (b) => {
    const ramp = bright(b);
    b.cylinder(
      0,
      0.7,
      0,
      0.7,
      6,
      {
        at: (x) => (Math.abs(x + 0.6) < 1.1 ? tone(RAMP.white, 3) : -1),
        tone: tone(ramp, 2),
      },
      "x",
    );
    b.cone(3.7, 0.7, 0, 0.7, 0.12, 1.4, { tone: tone(ramp, 3) }, "x");
  },
  reach: 4.6,
};

const cone: Toy = {
  bake: (b) => {
    b.box(0, 0.15, 0, 2.6, 0.3, 2.6, { tone: tone(RAMP.track, 1) });
    b.cone(0, 1.9, 0, 1.05, 0.22, 3.2, {
      at: (_x, y) => (y > 1.5 && y < 2.3 ? tone(RAMP.white, 3) : -1),
      tone: tone(RAMP.track, 2),
    });
  },
  reach: 1.9,
};

const brick: Toy = {
  bake: (b) => {
    const ramp = bright(b);
    b.box(0, 1, 0, 6, 2, 3, { tone: tone(ramp, 2) });
    for (const x of [-2.2, -0.75, 0.75, 2.2]) {
      for (const z of [-0.75, 0.75]) {
        b.cylinder(x, 2.2, z, 0.5, 0.4, { tone: tone(ramp, 3) });
      }
    }
  },
  reach: 3.6,
};

const tree: Toy = {
  bake: (b) => {
    b.cylinder(0, 1, 0, 0.5, 2, { tone: tone(RAMP.wood, 2) });
    b.cone(0, 3.2, 0, 2, 0.9, 2.6, { tone: tone(RAMP.green, 2) });
    b.cone(0, 5.3, 0, 1.4, 0.1, 2.4, { tone: tone(RAMP.green, 3) });
  },
  reach: 2.2,
};

const duck: Toy = {
  bake: (b) => {
    b.sphere(0, 1.5, 0, 2, { tone: tone(RAMP.yellow, 2) }, 0.75);
    b.sphere(1.3, 3.2, 0, 1.15, { tone: tone(RAMP.yellow, 3) });
    b.cone(2.6, 3.1, 0, 0.5, 0.2, 0.9, { tone: tone(RAMP.track, 2) }, "x");
    b.sphere(1.9, 3.6, 0.75, 0.22, { tone: tone(RAMP.black, 1) });
    b.sphere(1.9, 3.6, -0.75, 0.22, { tone: tone(RAMP.black, 1) });
  },
  reach: 3,
};

const rings: Toy = {
  bake: (b) => {
    b.cylinder(0, 0.25, 0, 2.4, 0.5, { tone: tone(RAMP.white, 2) });
    for (const [i, ramp] of [RAMP.red, RAMP.yellow, RAMP.green, RAMP.blue].entries()) {
      b.cylinder(0, 1 + i * 0.95, 0, 2.1 - i * 0.4, 0.9, { tone: tone(ramp, 2) });
    }
    b.sphere(0, 5, 0, 0.6, { tone: tone(RAMP.pink, 2) });
  },
  reach: 2.6,
};

const mug: Toy = {
  bake: (b) => {
    b.cylinder(0, 2.3, 0, 2.2, 4.6, {
      at: (_x, y) => (y > 2.8 && y < 3.6 ? tone(RAMP.blue, 2) : -1),
      tone: tone(RAMP.white, 3),
    });
    b.cylinder(0, 4.62, 0, 1.8, 0.05, { tone: tone(RAMP.wood, 0) });
  },
  reach: 2.6,
};

const dominoes: Toy = {
  bake: (b) => {
    for (let i = 0; i < 5; i += 1) {
      b.box(i * 1.5 - 3, 1.5, 0, 0.45, 3, 1.6, {
        at: (_x, y, z) =>
          Math.abs(z) < 0.3 && Math.abs((y % 1) - 0.5) < 0.2 ? tone(RAMP.black, 1) : -1,
        tone: tone(RAMP.white, 3),
      });
    }
  },
  reach: 3.8,
};

/** What lines the road, by room. */
export const TOYS = {
  bedroom: [blocks, books, ball, crayon, cone, tree, duck, blocks],
  kitchen: [mug, cone, brick, ball, mug, dominoes, blocks, crayon],
  playroom: [brick, rings, blocks, ball, duck, dominoes, tree, cone],
} as const;
