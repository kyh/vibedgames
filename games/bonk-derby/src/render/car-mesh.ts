import type * as THREE from "three";

import { FLAG, MeshBuilder } from "../pixel/mesh-builder";
import type { Coat } from "../pixel/mesh-builder";
import { BASE, RAMP, TEAM_RAMP, tone } from "../pixel/palette";
import type { PixelStage, Placement } from "../pixel/stage";
import { KINDS, SCOOP_REACH } from "../sim/kinds";
import type { CarKind } from "../sim/kinds";

/** What a car looks like this frame. */
export interface CarLook {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** -1 … 1: leans the body into the turn. */
  steer: number;
  /** Where its attack is, as `swingAt` gives it. */
  swing: number;
  /** The attack is armed and will go off on the next press. */
  ready: boolean;
  /** Drawn this many times its usual size. */
  size: number;
  /** Radians of tumble, about the car's length and across it. */
  roll: number;
  pitch: number;
  /** Seconds left of flashing pale after a hit. */
  flash: number;
  /** Just dropped in: drawn see-through. */
  ghost: boolean;
  /** Inside a shield. */
  shield: boolean;
  /** Sliding on oil: it spins as it goes. */
  slipping: boolean;
  boosting: boolean;
  /** Over the board: its shadow has somewhere to land. */
  grounded: boolean;
}

const wrap = (v: number, period: number) => ((v % period) + period) % period;
const team = (step: number) => tone(TEAM_RAMP, step);

const GLASS = tone(RAMP.glass, BASE - 1);
const GLINT = tone(RAMP.glass, BASE + 3);
const CREAM = tone(RAMP.cream, BASE + 1);

type Livery = (x: number, z: number) => boolean;

interface Body {
  long: number;
  wide: number;
  tall: number;
  mid: number;
  rake: number;
  cabAt: number;
  cabLong: number;
  cabWide: number;
  cabTall: number;
  tyre: number;
  axle: number;
  livery: Livery;
}

const shellOf = (body: Body) => {
  const low = body.mid - body.tall / 2;
  const top = body.mid + body.tall / 2;

  return {
    at: (x, y, z) => {
      if (y > top - 0.03) {
        return body.livery(x, z) ? CREAM : -1;
      }

      const nose = x > body.long / 2 - 0.08 && Math.abs(z) < body.wide * 0.26;

      if (nose && y > low + body.tall * 0.25 && y < low + body.tall * 0.7) {
        return tone(RAMP.black, wrap(z, 0.2) < 0.1 ? BASE - 1 : BASE - 2);
      }

      if (y < low + body.tall * 0.3) {
        return team(BASE - 1);
      }

      const stripe = Math.abs(y - (low + body.tall * 0.62)) < 0.05;

      return stripe && Math.abs(x) < body.long * 0.44 && Math.abs(z) > body.wide * 0.4 ? CREAM : -1;
    },
    tone: team(BASE),
  } satisfies Coat;
};

const cabOf = (body: Body) => {
  const low = body.mid + body.tall / 2;
  const top = low + body.cabTall;
  const back = body.cabAt - body.cabLong / 2;
  const front = body.cabAt + body.cabLong / 2;

  return {
    at: (x, y, z) => {
      if (y > top - 0.03) {
        return body.livery(x, z) ? CREAM : -1;
      }

      if (y < low + 0.12 || y > top - 0.1) {
        return -1;
      }

      const post = Math.abs(x - body.cabAt) < 0.07;
      const side = Math.abs(z) > body.cabWide * 0.4 && x > back + 0.18 && x < front - 0.18 && !post;
      const end = Math.abs(z) < body.cabWide * 0.36 && (x > front - 0.2 || x < back + 0.2);

      if (!side && !end) {
        return -1;
      }

      return wrap(x + y * 0.9 + Math.abs(z) * 0.4, 1.3) < 0.2 ? GLINT : GLASS;
    },
    tone: team(BASE + 1),
  } satisfies Coat;
};

const TYRE: Coat = { tone: tone(RAMP.black, BASE - 1) };
const HUB: Coat = { tone: tone(RAMP.steel, BASE + 1) };
const LAMP: Coat = { flags: FLAG.unlit, tone: tone(RAMP.cream, 7) };
const TAIL: Coat = { flags: FLAG.unlit, tone: tone(RAMP.red, BASE + 2) };
const IRON: Coat = { tone: tone(RAMP.iron, BASE) };
const STEEL: Coat = { tone: tone(RAMP.steel, BASE + 1) };

const chassis = (b: MeshBuilder, body: Body) => {
  const half = body.wide / 2;

  for (const [x, side] of [
    [body.axle, 1],
    [body.axle, -1],
    [-body.axle, 1],
    [-body.axle, -1],
  ] as const) {
    b.part();
    b.cylinder(x, body.tyre, side * (half - 0.09), body.tyre, 0.34, TYRE, "z");
    b.cylinder(x, body.tyre, side * (half + 0.09), body.tyre * 0.45, 0.04, HUB, "z");
  }

  const low = body.mid - body.tall / 2;
  const lamp = low + body.tall * 0.62;
  b.part();
  b.box(0, low - 0.1, 0, body.long - 0.2, 0.3, body.wide - 0.3, {
    flags: FLAG.noShadow,
    tone: tone(RAMP.black, BASE - 2),
  });
  b.part();
  b.taper(0, body.mid, 0, body.long, body.tall, body.wide, body.rake, 0.07, shellOf(body));
  b.part();
  b.taper(
    body.cabAt,
    body.mid + body.tall / 2 + body.cabTall / 2,
    0,
    body.cabLong,
    body.cabTall,
    body.cabWide,
    0.2,
    0.13,
    cabOf(body),
  );
  b.part();
  b.box(body.long / 2 - 0.01, lamp, half * 0.68, 0.1, 0.2, 0.34, LAMP);
  b.box(body.long / 2 - 0.01, lamp, -half * 0.68, 0.1, 0.2, 0.34, LAMP);
  b.box(-body.long / 2, lamp, half * 0.7, 0.08, 0.18, 0.3, TAIL);
  b.box(-body.long / 2, lamp, -half * 0.7, 0.08, 0.18, 0.3, TAIL);
};

const BUMPER: Body = {
  axle: 0.76,
  cabAt: -0.24,
  cabLong: 1.52,
  cabTall: 0.62,
  cabWide: 1.48,
  livery: (_x, z) => Math.abs(z) < 0.2,
  long: 2.4,
  mid: 0.8,
  rake: 0.07,
  tall: 0.62,
  tyre: 0.38,
  wide: 1.66,
};

const DART: Body = {
  axle: 0.86,
  cabAt: -0.4,
  cabLong: 1.2,
  cabTall: 0.46,
  cabWide: 1.22,
  livery: (_x, z) => Math.abs(z) > 0.2 && Math.abs(z) < 0.4,
  long: 2.7,
  mid: 0.68,
  rake: 0.34,
  tall: 0.46,
  tyre: 0.34,
  wide: 1.5,
};

const BRICK: Body = {
  axle: 0.8,
  cabAt: -0.1,
  cabLong: 1.7,
  cabTall: 0.66,
  cabWide: 1.7,
  livery: (x, _z) => Math.abs(x + 0.1) < 0.2 || (x > 0.8 && x < 1.05),
  long: 2.5,
  mid: 1,
  rake: 0.05,
  tall: 0.86,
  tyre: 0.5,
  wide: 1.92,
};

const POPPER: Body = {
  axle: 0.74,
  cabAt: -0.56,
  cabLong: 1,
  cabTall: 0.58,
  cabWide: 1.4,
  livery: (x, z) => Math.abs(z) < 0.5 && x > 0.6 && x < 1,
  long: 2.3,
  mid: 0.8,
  rake: 0.07,
  tall: 0.62,
  tyre: 0.38,
  wide: 1.62,
};

const SCOOP: Body = {
  axle: 0.74,
  cabAt: -0.36,
  cabLong: 1.3,
  cabTall: 0.6,
  cabWide: 1.5,
  livery: (x, z) => Math.abs(z) < 0.46 && Math.abs(x + 0.36) < 0.4,
  long: 2.3,
  mid: 0.86,
  rake: 0.06,
  tall: 0.7,
  tyre: 0.42,
  wide: 1.78,
};

const TWISTER: Body = {
  axle: 0.68,
  cabAt: 0,
  cabLong: 1.2,
  cabTall: 0.56,
  cabWide: 1.26,
  livery: (x, z) => Math.hypot(x, z) < 0.34,
  long: 2.2,
  mid: 0.84,
  rake: 0.16,
  tall: 0.6,
  tyre: 0.36,
  wide: 1.66,
};

const MODELS: Record<CarKind, (b: MeshBuilder) => void> = {
  brick: (b) => {
    chassis(b, BRICK);
    b.part();
    b.box(1.34, 0.86, 0, 0.14, 0.62, 1.76, IRON);
    b.box(1.34, 0.86, 0, 0.16, 0.14, 1.9, STEEL);
    b.part();
    b.box(-0.1, 2.16, 0, 1.1, 0.12, 1.3, STEEL);
  },
  bumper: (b) => {
    chassis(b, BUMPER);
  },
  dart: (b) => {
    chassis(b, DART);
    b.part();
    b.box(-1.14, 1.08, 0.5, 0.1, 0.3, 0.1, IRON);
    b.box(-1.14, 1.08, -0.5, 0.1, 0.3, 0.1, IRON);
    b.part();
    b.box(-1.18, 1.27, 0, 0.36, 0.08, 1.56, { tone: team(BASE + 1) });
    b.part();
    b.taper(1.3, 0.56, 0, 0.5, 0.22, 1.1, 0.2, 0.1, { tone: tone(RAMP.cream, BASE) });
  },
  popper: (b) => {
    chassis(b, POPPER);
    b.part();
    b.cylinder(0.34, 1.26, 0, 0.46, 0.3, IRON);
    b.part();
    b.cylinder(0.98, 1.34, 0, 0.2, 1.3, STEEL, "x");
    b.cylinder(1.6, 1.34, 0, 0.27, 0.16, { tone: tone(RAMP.cream, BASE + 1) }, "x");
  },
  scoop: (b) => {
    chassis(b, SCOOP);
    b.part();
    b.box(1, 0.62, 0.82, 0.9, 0.16, 0.14, IRON);
    b.box(1, 0.62, -0.82, 0.9, 0.16, 0.14, IRON);
  },
  twister: (b) => {
    chassis(b, TWISTER);
    b.part();
    b.cylinder(0, 0.62, 0, 1.52, 0.2, {
      at: (x, _y, z) =>
        wrap(Math.atan2(z, x), Math.PI / 4) < Math.PI / 10 ? tone(RAMP.cream, BASE + 1) : -1,
      tone: tone(RAMP.steel, BASE),
    });
    b.part();
    b.cone(0, 1.86, 0, 0.3, 0.06, 0.34, { tone: tone(RAMP.cream, BASE + 1) });
  },
};

const plate = (armed: boolean) => (b: MeshBuilder) => {
  b.part();
  b.box(-0.15, 0.72, 0, 0.2, 0.5, 1.34, { tone: tone(RAMP.iron, BASE) });
  b.part();
  b.box(0.1, 0.72, 0, 0.3, 0.66, 1.56, {
    at: (_x, y, z) => {
      if (Math.abs(z) > 0.62) {
        return tone(RAMP.iron, BASE - 1);
      }

      return armed && y > 0.86 ? tone(RAMP.cream, 7) : -1;
    },
    tone: tone(RAMP.cream, armed ? BASE + 1 : BASE - 1),
  });
};

const blade = (armed: boolean) => (b: MeshBuilder) => {
  b.part();
  b.taper(0.1, 0.5, 0, 0.7, 0.72, 2.2, 0.26, 0.04, {
    at: (_x, y, z) => {
      if (y < 0.26) {
        return tone(RAMP.iron, BASE - 1);
      }

      return armed && Math.abs(z) < 0.8 && y > 0.6 ? tone(RAMP.cream, 7) : -1;
    },
    tone: tone(RAMP.steel, armed ? BASE + 1 : BASE - 1),
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

const BODIES: Record<CarKind, THREE.BufferGeometry> = {
  brick: bake(MODELS.brick),
  bumper: bake(MODELS.bumper),
  dart: bake(MODELS.dart),
  popper: bake(MODELS.popper),
  scoop: bake(MODELS.scoop),
  twister: bake(MODELS.twister),
};

const COIL_LINK = bake(coil);
const PLATE = { armed: bake(plate(true)), spent: bake(plate(false)) };
const BLADE = { armed: bake(blade(true)), spent: bake(blade(false)) };

const BEACON = bake((b) => {
  b.part();
  b.box(0, 0.09, 0, 0.3, 0.18, 0.3, {
    flags: FLAG.unlit + FLAG.noShadow,
    tone: tone(RAMP.cream, 7),
  });
});

const BUBBLE = bake((b) => {
  b.part();
  b.sphere(0, 1, 0, 2.1, {
    flags: FLAG.unlit + FLAG.noShadow + FLAG.noOutline,
    tone: tone(RAMP.glass, BASE + 3),
  });
});

const BEACONS: Partial<Record<CarKind, readonly [number, number]>> = {
  brick: [-0.1, 2.22],
  dart: [-0.4, 1.38],
  popper: [-0.56, 2],
  twister: [0, 2.04],
};

const BLOB = tone(RAMP.tile, 1);
const YAW_STEPS = 64;
const DRAWN = 1.22;
const TALL = 1.2;
const SHADOW_SLIP = 0.35;

const snapYaw = (yaw: number) =>
  (Math.round((yaw / (Math.PI * 2)) * YAW_STEPS) / YAW_STEPS) * Math.PI * 2;

export class CarMesh {
  readonly kind: CarKind;
  private look: CarLook | null = null;
  private lean = 0;
  private squash = 0;
  private size = 1;
  private age = 0;

  constructor(kind: CarKind) {
    this.kind = kind;
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
    this.size += (look.size - this.size) * Math.min(1, dt * 9);
  }

  /** Put the car on stage in the colour `ramp`. */
  draw(stage: PixelStage, ramp: number) {
    const { kind, look } = this;

    if (!look) {
      return;
    }

    const { attack } = KINDS[kind];
    const swing = Math.max(0, look.swing);
    const whirl = attack === "spin" ? swing * Math.PI * 4 : 0;
    const yaw = snapYaw(look.heading + whirl + (look.slipping ? this.age * 13 : 0));
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const lifted = Math.max(0, look.y);
    const size = this.size * DRAWN * (1 + Math.min(lifted, 4.5) * 0.07);
    this.shade(stage, look, cos, sin, lifted);
    const lit = look.flash > 0 && Math.floor(look.flash * 30) % 2 === 0;
    const flat = attack === "slam" ? swing * 0.3 : 0;
    const kick = attack === "shot" ? swing * 0.12 : 0;

    const place: Placement = {
      aloft: look.y > 1.8 || look.ghost,
      pitch: look.pitch + (look.boosting ? 0.06 : 0) + kick,
      ramp: lit ? RAMP.cream : ramp,
      roll: look.roll + this.lean,
      scale: size,
      sheer: look.ghost && Math.floor(this.age * 10) % 2 === 0,
      squash: TALL * (1 - Math.sin(this.squash * Math.PI) * 0.22 - flat),
      x: look.x,
      y: look.y + 0.05,
      yaw,
      z: look.z,
    };

    stage.draw(BODIES[kind], place);

    if (attack === "dash" && swing > 0) {
      for (const back of [1.3, 2.6]) {
        stage.draw(BODIES[kind], {
          ...place,
          sheer: true,
          x: look.x - cos * back * swing,
          z: look.z - sin * back * swing,
        });
      }
    }

    this.gear(stage, look, place, size);

    if (look.shield) {
      stage.draw(BUBBLE, {
        ramp,
        scale: size / DRAWN,
        sheer: true,
        x: look.x,
        y: look.y,
        yaw: 0,
        z: look.z,
      });
    }
  }

  private shade(stage: PixelStage, look: CarLook, cos: number, sin: number, lifted: number) {
    if (stage.shadows || !look.grounded || look.y < -0.5) {
      return;
    }

    const spread = Math.max(0.35, 1 - lifted * 0.3) * this.size;

    for (const along of [-0.7, 0, 0.7]) {
      stage.dabs.push(
        look.x + cos * along * spread - SHADOW_SLIP,
        0.06,
        look.z + sin * along * spread + SHADOW_SLIP,
        0.95 * spread,
        BLOB,
        true,
      );
    }
  }

  private gear(stage: PixelStage, look: CarLook, place: Placement, size: number) {
    const { kind } = this;
    const { attack } = KINDS[kind];
    const cos = Math.cos(place.yaw);
    const sin = Math.sin(place.yaw);
    const at = (along: number) => ({ x: look.x + cos * along, z: look.z + sin * along });

    if (attack === "punch") {
      for (let k = 0.4; k < look.swing; k += 0.5) {
        stage.draw(COIL_LINK, { ...place, ...at((1.3 + k) * size) });
      }

      stage.draw(look.ready ? PLATE.armed : PLATE.spent, {
        ...place,
        ...at((1.36 + look.swing) * size),
      });
    } else if (attack === "scoop") {
      const up = Math.min(1, Math.max(0, look.swing) / SCOOP_REACH);
      stage.draw(look.ready ? BLADE.armed : BLADE.spent, {
        ...place,
        ...at((1.36 + up * 0.5) * size),
        pitch: (place.pitch ?? 0) + up * 0.9,
        y: place.y + up * 0.7 * size,
      });
    }

    const beacon = BEACONS[kind];

    if (beacon && look.ready) {
      stage.draw(BEACON, {
        ...place,
        ...at(beacon[0] * size),
        y: place.y + beacon[1] * size * (place.squash ?? 1),
      });
    }
  }
}
