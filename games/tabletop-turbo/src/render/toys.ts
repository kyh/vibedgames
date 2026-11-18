// What a toy track gets built between. Each room has its own things and its
// own two colours, so a frame reads as one palette: the floor, the orange of
// the track, the room's pair, and the karts.
//
// A toy bakes itself around the origin of a builder already placed and turned.
// `reach` is how far it spreads and `height` how tall it stands, so the world
// can keep it off the road and out of the camera's way.

import type { Room } from "../sim/track";
import type { SplatBuilder } from "../splat/builder";
import { RAMP } from "../splat/palette";
import { tone } from "../splat/splat-set";

export interface Toy {
  reach: number;
  height: number;
  bake: (b: SplatBuilder, colours: readonly number[]) => void;
}

const pick = (b: SplatBuilder, colours: readonly number[]): number =>
  colours[Math.floor(b.random() * colours.length)] ?? RAMP.white;

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
  bake: (b, colours) => {
    block(b, 2.6, pick(b, colours));
    if (b.random() > 0.5) {
      block(b, 2, pick(b, colours), 2.6);
    }
  },
  height: 4.6,
  reach: 2.4,
};

const books: Toy = {
  bake: (b, colours) => {
    let y = 0;
    const count = 2 + Math.floor(b.random() * 2);
    for (let i = 0; i < count; i += 1) {
      const ramp = pick(b, colours);
      const thick = 1.1 + b.random() * 0.6;
      const dx = (b.random() - 0.5) * 1.2;
      // Pages between two covers.
      b.box(dx, y + thick / 2, 0, 9.4, thick - 0.4, 6.4, { tone: tone(RAMP.white, 3) });
      b.box(dx, y + thick - 0.1, 0, 9.8, 0.2, 6.8, { tone: tone(ramp, 2) });
      b.box(dx - 4.8, y + thick / 2, 0, 0.3, thick, 6.8, { tone: tone(ramp, 1) });
      y += thick;
    }
  },
  height: 3.4,
  reach: 6.5,
};

const ball: Toy = {
  bake: (b, colours) => {
    const r = 1.8 + b.random();
    b.sphere(0, r, 0, r, {
      // Beach-ball panels.
      at: (x, _y, z) => {
        const panel = Math.floor(((Math.atan2(z, x) + Math.PI) / Math.PI) * 3);
        return panel % 2 === 0 ? tone(RAMP.white, 3) : -1;
      },
      tone: tone(pick(b, colours), 2),
    });
  },
  height: 5,
  reach: 2.8,
};

const crayon: Toy = {
  bake: (b, colours) => {
    const ramp = pick(b, colours);
    b.cylinder(
      0,
      0.7,
      0,
      0.7,
      6,
      { at: (x) => (Math.abs(x + 0.6) < 1.1 ? tone(RAMP.white, 3) : -1), tone: tone(ramp, 2) },
      "x",
    );
    b.cone(3.7, 0.7, 0, 0.7, 0.12, 1.4, { tone: tone(ramp, 3) }, "x");
  },
  height: 1.4,
  reach: 4.6,
};

const cone: Toy = {
  bake: (b) => {
    b.box(0, 0.15, 0, 2.2, 0.3, 2.2, { tone: tone(RAMP.track, 1) });
    b.cone(0, 1.6, 0, 0.9, 0.2, 2.6, {
      at: (_x, y) => (y > 1.3 && y < 2 ? tone(RAMP.white, 3) : -1),
      tone: tone(RAMP.track, 2),
    });
  },
  height: 2.9,
  reach: 1.6,
};

const brick: Toy = {
  bake: (b, colours) => {
    const ramp = pick(b, colours);
    b.box(0, 1, 0, 6, 2, 3, { tone: tone(ramp, 2) });
    for (const x of [-2.2, -0.75, 0.75, 2.2]) {
      for (const z of [-0.75, 0.75]) {
        b.cylinder(x, 2.2, z, 0.5, 0.4, { tone: tone(ramp, 3) });
      }
    }
  },
  height: 2.4,
  reach: 3.6,
};

const duck: Toy = {
  bake: (b) => {
    b.sphere(0, 1.5, 0, 2, { tone: tone(RAMP.yellow, 2) }, 0.75);
    b.sphere(1.3, 3.2, 0, 1.15, { tone: tone(RAMP.yellow, 3) });
    b.cone(2.6, 3.1, 0, 0.5, 0.2, 0.9, { tone: tone(RAMP.track, 2) }, "x");
    b.sphere(1.9, 3.6, 0.75, 0.22, { tone: tone(RAMP.black, 1) });
    b.sphere(1.9, 3.6, -0.75, 0.22, { tone: tone(RAMP.black, 1) });
  },
  height: 4.4,
  reach: 3,
};

const rings: Toy = {
  bake: (b, colours) => {
    b.cylinder(0, 0.25, 0, 2.4, 0.5, { tone: tone(RAMP.white, 2) });
    for (let i = 0; i < 4; i += 1) {
      const ramp = colours[i % colours.length] ?? RAMP.white;
      b.cylinder(0, 1 + i * 0.95, 0, 2.1 - i * 0.4, 0.9, { tone: tone(ramp, 2 + (i % 2)) });
    }
  },
  height: 4.6,
  reach: 2.6,
};

const mug: Toy = {
  bake: (b, colours) => {
    const band = pick(b, colours);
    b.cylinder(0, 1.9, 0, 1.9, 3.8, {
      at: (_x, y) => (y > 2.2 && y < 3 ? tone(band, 2) : -1),
      tone: tone(RAMP.white, 3),
    });
    b.cylinder(0, 3.82, 0, 1.55, 0.05, { tone: tone(RAMP.wood, 0) });
  },
  height: 3.8,
  reach: 2.2,
};

/** Sugar cubes, spilled. */
const sugar: Toy = {
  bake: (b) => {
    for (let i = 0; i < 6; i += 1) {
      const a = b.random() * Math.PI * 2;
      const d = b.random() * 2.6;
      b.box(Math.cos(a) * d, 0.5, Math.sin(a) * d, 1, 1, 1, { tone: tone(RAMP.white, 3) });
    }
  },
  height: 1,
  reach: 3.4,
};

const dominoes: Toy = {
  bake: (b) => {
    for (let i = 0; i < 5; i += 1) {
      b.box(i * 1.5 - 3, 1.3, 0, 0.45, 2.6, 1.5, {
        at: (_x, y, z) =>
          Math.abs(z) < 0.3 && Math.abs((y % 1) - 0.5) < 0.2 ? tone(RAMP.black, 1) : -1,
        tone: tone(RAMP.white, 3),
      });
    }
  },
  height: 2.6,
  reach: 3.8,
};

// --- set pieces: one or two to a room, at room scale --------------------------

/** A bed leg and the corner of the frame it holds up. */
const bedLeg: Toy = {
  bake: (b) => {
    b.box(0, 7, 0, 5, 14, 5, { tone: tone(RAMP.wood, 1) });
    b.box(0, 0.4, 0, 6, 0.8, 6, { tone: tone(RAMP.wood, 0) });
    // A hem of blanket hanging over the edge.
    b.box(3, 12, -6, 13, 4, 2, {
      at: (x) => (Math.floor(x / 1.6) % 2 === 0 ? tone(RAMP.white, 3) : -1),
      tone: tone(RAMP.red, 2),
    });
  },
  height: 14,
  reach: 9,
};

const slipper: Toy = {
  bake: (b) => {
    b.sphere(0, 1.2, 0, 4.2, { tone: tone(RAMP.red, 2) }, 0.36);
    b.sphere(5.5, 1.1, 0, 3.4, { tone: tone(RAMP.red, 1) }, 0.3);
    b.sphere(-1.2, 2.2, 0, 3, { tone: tone(RAMP.white, 3) }, 0.5);
  },
  height: 3.8,
  reach: 8.5,
};

const cerealBox: Toy = {
  bake: (b) => {
    b.box(0, 7, 0, 9, 14, 3.4, {
      at: (x, y) => {
        if (y > 9.5 && y < 12) {
          return tone(RAMP.white, 4);
        }
        // A bowl of something on the front.
        return Math.hypot(x, y - 5) < 3 ? tone(RAMP.white, 3) : -1;
      },
      tone: tone(RAMP.yellow, 2),
    });
  },
  height: 14,
  reach: 5,
};

const plate: Toy = {
  bake: (b) => {
    b.cylinder(0, 0.3, 0, 7, 0.6, {
      at: (x, _y, z) => (Math.hypot(x, z) > 5.6 ? tone(RAMP.blue, 2) : -1),
      tone: tone(RAMP.white, 3),
    });
    // Toast.
    b.box(0.5, 1, -0.5, 5, 0.9, 5, {
      at: (x, _y, z) => (Math.abs(x - 0.5) > 2 || Math.abs(z + 0.5) > 2 ? tone(RAMP.wood, 2) : -1),
      tone: tone(RAMP.wood, 4),
    });
  },
  height: 1.5,
  reach: 7.2,
};

const toyChest: Toy = {
  bake: (b) => {
    b.box(0, 4, 0, 16, 8, 9, {
      at: (x, y) => (Math.abs(x) > 7 || y > 6.6 || y < 1 ? tone(RAMP.wood, 1) : -1),
      tone: tone(RAMP.wood, 3),
    });
    b.box(0, 5, 4.6, 2, 2, 0.4, { tone: tone(RAMP.yellow, 2) });
  },
  height: 8,
  reach: 9.5,
};

/** A tower of blocks someone is halfway through. */
const tower: Toy = {
  bake: (b, colours) => {
    for (let i = 0; i < 4; i += 1) {
      block(b, 3 - i * 0.3, colours[i % colours.length] ?? RAMP.white, i * 2.9);
    }
  },
  height: 11,
  reach: 3,
};

export interface RoomKit {
  /** The room's own pair of colours, beyond wood, white and the track's orange. */
  colours: readonly number[];
  toys: readonly Toy[];
  setPieces: readonly Toy[];
}

/** What stands in each room. */
export const KITS: Record<Room, RoomKit> = {
  bedroom: {
    colours: [RAMP.red, RAMP.yellow],
    setPieces: [bedLeg, slipper, books, bedLeg, books, slipper],
    toys: [blocks, ball, crayon, cone, duck, blocks, crayon],
  },
  kitchen: {
    colours: [RAMP.blue, RAMP.yellow],
    setPieces: [cerealBox, plate, cerealBox, plate, cerealBox, plate],
    toys: [mug, sugar, cone, mug, sugar, crayon],
  },
  playroom: {
    colours: [RAMP.yellow, RAMP.pink],
    setPieces: [toyChest, tower, tower, toyChest, tower, toyChest],
    toys: [brick, rings, blocks, ball, dominoes, cone],
  },
};
