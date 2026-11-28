import type * as THREE from "three";

import { FLAG, MeshBuilder } from "../pixel/mesh-builder";
import type { Coat } from "../pixel/mesh-builder";
import { BASE, CAR_RAMPS, RAMP, TEAM_RAMP, tone } from "../pixel/palette";
import type { PixelStage, Placement } from "../pixel/stage";

/** Which bumper a car carries on its nose. */
export type BumperLook = "plain" | "mega" | "spring";

/** What a car looks like this frame. */
export interface CarLook {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** -1 … 1: leans the body into the turn. */
  steer: number;
  /** How far the bumper is out, in car lengths of travel: negative is wound back. */
  bumper: number;
  bumperLook: BumperLook;
  /** The bumper is armed and will fire on the next press. */
  ready: boolean;
  /** Drawn this many times its usual size. */
  size: number;
  /** Radians of tumble, about the car's length and across it. */
  roll: number;
  pitch: number;
  /** Seconds left of flashing white after a hit. */
  flash: number;
  /** Shielded: drawn see-through. */
  ghost: boolean;
  boosting: boolean;
  /** Over the board: its shadow has somewhere to land. */
  grounded: boolean;
}

const wrap = (v: number, period: number) => ((v % period) + period) % period;
const team = (step: number) => tone(TEAM_RAMP, step);

const GLASS = tone(RAMP.glass, BASE - 1);
const GLINT = tone(RAMP.glass, BASE + 3);

const LIVERIES = [
  (_x: number, z: number) => Math.abs(z) < 0.2,
  (_x: number, z: number) => Math.abs(z) > 0.24 && Math.abs(z) < 0.46,
  (x: number, _z: number) => Math.abs(x + 0.24) < 0.2 || (x > 0.62 && x < 0.86),
  (x: number, z: number) => Math.abs(z) < 0.42 && Math.abs(x + 0.24) < 0.42,
] as const;

type Livery = (typeof LIVERIES)[number];

const CREAM = tone(RAMP.cream, BASE + 1);

const shellOf = (livery: Livery) =>
  ({
    at: (x, y, z) => {
      if (y > 1.1) {
        return livery(x, z) ? CREAM : -1;
      }

      if (x > 1.15 && Math.abs(z) < 0.42 && y > 0.62 && y < 0.92) {
        return tone(RAMP.black, wrap(z, 0.2) < 0.1 ? BASE - 1 : BASE - 2);
      }

      if (y < 0.66) {
        return team(BASE - 1);
      }

      return Math.abs(y - 0.88) < 0.05 && Math.abs(x) < 1.1 && Math.abs(z) > 0.7 ? CREAM : -1;
    },
    tone: team(BASE),
  }) satisfies Coat;

const cabinOf = (livery: Livery) =>
  ({
    at: (x, y, z) => {
      if (y > 1.7) {
        return livery(x, z) ? CREAM : -1;
      }

      if (y < 1.24 || y > 1.64) {
        return -1;
      }

      const side = Math.abs(z) > 0.6 && x > -0.82 && x < 0.34 && Math.abs(x + 0.24) > 0.07;
      const end = Math.abs(z) < 0.52 && (x > 0.3 || x < -0.76);

      if (!side && !end) {
        return -1;
      }

      return wrap(x + y * 0.9 + Math.abs(z) * 0.4, 1.3) < 0.2 ? GLINT : GLASS;
    },
    tone: team(BASE + 1),
  }) satisfies Coat;

const TYRE: Coat = { tone: tone(RAMP.black, BASE - 1) };
const HUB: Coat = { tone: tone(RAMP.steel, BASE + 1) };
const LAMP: Coat = { flags: FLAG.unlit, tone: tone(RAMP.cream, 7) };
const TAIL: Coat = { flags: FLAG.unlit, tone: tone(RAMP.red, BASE + 2) };

const cube = (livery: Livery) => (b: MeshBuilder) => {
  for (const [x, side] of [
    [0.76, 1],
    [0.76, -1],
    [-0.76, 1],
    [-0.76, -1],
  ] as const) {
    b.part();
    b.cylinder(x, 0.38, side * 0.74, 0.38, 0.34, TYRE, "z");
    b.cylinder(x, 0.38, side * 0.92, 0.17, 0.04, HUB, "z");
  }

  b.part();
  b.box(0, 0.4, 0, 2.2, 0.3, 1.36, { flags: FLAG.noShadow, tone: tone(RAMP.black, BASE - 2) });
  b.part();
  b.taper(0, 0.8, 0, 2.4, 0.62, 1.66, 0.07, 0.07, shellOf(livery));
  b.part();
  b.taper(-0.24, 1.42, 0, 1.52, 0.62, 1.48, 0.2, 0.13, cabinOf(livery));
  b.part();
  b.box(1.19, 0.92, 0.56, 0.1, 0.2, 0.34, LAMP);
  b.box(1.19, 0.92, -0.56, 0.1, 0.2, 0.34, LAMP);
  b.box(-1.2, 0.92, 0.58, 0.08, 0.18, 0.3, TAIL);
  b.box(-1.2, 0.92, -0.58, 0.08, 0.18, 0.3, TAIL);
};

const PLATES = {
  mega: RAMP.red,
  plain: RAMP.steel,
  spring: RAMP.blue,
} as const satisfies Record<BumperLook, number>;

const bumper =
  (look: BumperLook, width: number, depth: number, armed: boolean) => (b: MeshBuilder) => {
    const ramp = PLATES[look];
    b.part();
    b.box(-depth * 0.3, 0.72, 0, depth * 0.4, 0.5, width * 0.86, { tone: tone(RAMP.iron, BASE) });
    b.part();
    b.box(depth * 0.2, 0.72, 0, depth * 0.6, 0.66, width, {
      at: (_x, y, z) => {
        if (Math.abs(z) > width / 2 - 0.16) {
          return tone(RAMP.iron, BASE - 1);
        }

        return armed && y > 0.86 ? tone(RAMP.cream, 7) : -1;
      },
      tone: tone(ramp === RAMP.steel ? RAMP.cream : ramp, armed ? BASE + 1 : BASE - 1),
    });
  };

const coil = (b: MeshBuilder) => {
  b.part();
  b.box(0, 0.72, 0, 0.5, 0.3, 0.46, {
    at: (x) => (wrap(x, 0.25) < 0.125 ? tone(RAMP.steel, BASE - 2) : -1),
    tone: tone(RAMP.steel, BASE + 2),
  });
};

const bake = (build: (b: MeshBuilder) => void) => {
  const builder = new MeshBuilder(0.09);
  build(builder);

  return builder.build();
};

const BODIES = LIVERIES.map((livery) => bake(cube(livery)));
const COIL_LINK = bake(coil);

const BUMPERS: Record<BumperLook, { armed: THREE.BufferGeometry; spent: THREE.BufferGeometry }> = {
  mega: {
    armed: bake(bumper("mega", 2.5, 0.8, true)),
    spent: bake(bumper("mega", 2.5, 0.8, false)),
  },
  plain: {
    armed: bake(bumper("plain", 1.56, 0.5, true)),
    spent: bake(bumper("plain", 1.56, 0.5, false)),
  },
  spring: {
    armed: bake(bumper("spring", 1.3, 0.6, true)),
    spent: bake(bumper("spring", 1.3, 0.6, false)),
  },
};

const BLOB = tone(RAMP.iron, 1);
const YAW_STEPS = 64;
const DRAWN = 1.22;
const TALL = 1.2;

const snapYaw = (yaw: number) =>
  (Math.round((yaw / (Math.PI * 2)) * YAW_STEPS) / YAW_STEPS) * Math.PI * 2;

export class CarMesh {
  visible = true;
  private readonly ramp: number;
  private readonly body: THREE.BufferGeometry | undefined;
  private look: CarLook | null = null;
  private lean = 0;
  private squash = 0;
  private age = 0;

  constructor(ramp: number) {
    this.ramp = ramp;
    this.body = BODIES[Math.max(0, CAR_RAMPS.indexOf(ramp)) % BODIES.length];
  }

  /** A hit or a landing: squash down and spring back. */
  thump() {
    this.squash = 1;
  }

  update(look: CarLook, dt: number) {
    this.look = look;
    this.age += dt;
    this.lean += (look.steer * 0.1 - this.lean) * Math.min(1, dt * 10);
    this.squash = Math.max(0, this.squash - dt * 5);
  }

  draw(stage: PixelStage) {
    const { body, look } = this;

    if (!look || !body || !this.visible) {
      return;
    }

    const yaw = snapYaw(look.heading);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const lifted = Math.max(0, look.y);
    const size = look.size * DRAWN * (1 + lifted * 0.12);

    if (!stage.shadows && look.grounded && look.y > -0.5) {
      const spread = Math.max(0.35, 1 - lifted * 0.3) * look.size;

      for (const along of [-0.6, 0, 0.6]) {
        stage.dabs.push(
          look.x + cos * along * spread,
          0.06,
          look.z + sin * along * spread,
          1.1 * spread,
          BLOB,
          true,
        );
      }
    }

    const white = look.flash > 0 && Math.floor(look.flash * 30) % 2 === 0;

    const place: Placement = {
      aloft: look.y > 1.8 || look.ghost,
      mono: white,
      pitch: look.pitch + (look.boosting ? 0.06 : 0),
      ramp: white ? RAMP.white : this.ramp,
      roll: look.roll + this.lean,
      scale: size,
      sheer: look.ghost && Math.floor(this.age * 10) % 2 === 0,
      squash: TALL * (1 - Math.sin(this.squash * Math.PI) * 0.22),
      x: look.x,
      y: look.y + 0.05,
      yaw,
      z: look.z,
    };

    stage.draw(body, place);
    const set = BUMPERS[look.bumperLook];
    const reach = (1.36 + look.bumper) * size;

    if (look.bumper > 0.25) {
      for (let k = 0.4; k < look.bumper; k += 0.5) {
        const at = (1.3 + k) * size;
        stage.draw(COIL_LINK, { ...place, x: look.x + cos * at, z: look.z + sin * at });
      }
    }

    stage.draw(look.ready ? set.armed : set.spent, {
      ...place,
      x: look.x + cos * reach,
      z: look.z + sin * reach,
    });
  }
}
