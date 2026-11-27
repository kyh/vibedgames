import { SplatBuilder } from "../splat/builder";
import type { Coat } from "../splat/builder";
import { drawSplats } from "../splat/draw";
import { RAMP, TEAM_RAMP } from "../splat/palette";
import { FLAG, SplatSet, tone } from "../splat/splat-set";

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
  /** Blinking through a spell of invulnerability. */
  ghost: boolean;
  boosting: boolean;
  /** Over the board: its shadow has somewhere to land. */
  grounded: boolean;
}

const BRIGHT = FLAG.bright;
const SPACING = 0.14;
const body = (step: number) => ({ flags: BRIGHT, tone: tone(TEAM_RAMP, step) }) satisfies Coat;

const RUBBER: Coat = { flags: BRIGHT, tone: tone(RAMP.black, 1) };
const LAMP: Coat = { flags: FLAG.unlit, tone: tone(RAMP.cream, 4) };
const TAIL: Coat = { flags: FLAG.unlit, tone: tone(RAMP.red, 3) };

const GLASS = tone(TEAM_RAMP, 0);

const cabin: Coat = {
  at: (x, y, z) => {
    if (y > 1.6) {
      return x > 0.3 || x < -0.74 || Math.abs(z) > 0.56 ? GLASS : -1;
    }

    return y > 1.18 ? GLASS : -1;
  },
  flags: BRIGHT,
  tone: tone(TEAM_RAMP, 3),
};

const cube = (b: SplatBuilder) => {
  for (const side of [-1, 1]) {
    b.cylinder(0.74, 0.36, side * 0.76, 0.36, 0.3, RUBBER, "z");
    b.cylinder(-0.74, 0.36, side * 0.76, 0.36, 0.3, RUBBER, "z");
  }

  b.box(0, 0.72, 0, 2.36, 0.72, 1.6, body(2));
  b.box(-0.2, 1.36, 0, 1.5, 0.6, 1.44, cabin);
  b.box(1.04, 1.1, 0.52, 0.3, 0.06, 0.4, LAMP);
  b.box(1.04, 1.1, -0.52, 0.3, 0.06, 0.4, LAMP);
  b.box(-1.08, 1.1, 0.54, 0.22, 0.06, 0.36, TAIL);
  b.box(-1.08, 1.1, -0.54, 0.22, 0.06, 0.36, TAIL);
};

const BUMPER: Coat = { flags: BRIGHT, tone: tone(RAMP.cream, 2) };
const BUMPER_READY: Coat = { flags: FLAG.unlit, tone: tone(RAMP.cream, 4) };
const COIL: Coat = { flags: BRIGHT, tone: tone(RAMP.white, 1) };

const bumper = (width: number, depth: number, coat: Coat) => (b: SplatBuilder) => {
  b.box(0, 0.7, 0, depth, 0.62, width, coat);
};

const coil = (b: SplatBuilder) => {
  b.box(0, 0.7, 0, 0.34, 0.26, 0.5, COIL);
};

const bake = (build: (b: SplatBuilder) => void, seed: number) => {
  const builder = new SplatBuilder(SPACING, new SplatSet(2048), seed);
  build(builder);

  return builder.set;
};

const BODY = bake(cube, 11);
const COIL_LINK = bake(coil, 12);

const BUMPERS: Record<BumperLook, { armed: SplatSet; spent: SplatSet }> = {
  mega: {
    armed: bake(bumper(2.5, 0.8, BUMPER_READY), 15),
    spent: bake(bumper(2.5, 0.8, BUMPER), 16),
  },
  plain: {
    armed: bake(bumper(1.5, 0.5, BUMPER_READY), 13),
    spent: bake(bumper(1.5, 0.5, BUMPER), 14),
  },
  spring: {
    armed: bake(bumper(1.3, 0.6, BUMPER_READY), 17),
    spent: bake(bumper(1.3, 0.6, BUMPER), 18),
  },
};

const SHADOW = tone(RAMP.navy, 0);
const SHADOW_FLAGS = FLAG.noShadow;
const YAW_STEPS = 64;
const DRAWN = 1.12;

const snapYaw = (yaw: number) =>
  (Math.round((yaw / (Math.PI * 2)) * YAW_STEPS) / YAW_STEPS) * Math.PI * 2;

export class CarMesh {
  visible = true;
  private readonly ramp: number;
  private look: CarLook | null = null;
  private lean = 0;
  private squash = 0;
  private clock = 0;

  constructor(ramp: number) {
    this.ramp = ramp;
  }

  /** A hit or a landing: squash down and spring back. */
  thump() {
    this.squash = 1;
  }

  update(look: CarLook, dt: number) {
    this.look = look;
    this.clock += dt;
    this.lean += (look.steer * 0.1 - this.lean) * Math.min(1, dt * 10);
    this.squash = Math.max(0, this.squash - dt * 5);
  }

  draw(out: SplatSet) {
    const { look } = this;

    if (!look || !this.visible || (look.ghost && Math.floor(this.clock * 14) % 2 === 0)) {
      return;
    }

    const yaw = snapYaw(look.heading);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const lifted = Math.max(0, look.y);
    const size = look.size * DRAWN * (1 + lifted * 0.12);

    if (look.grounded && look.y > -0.5) {
      const spread = Math.max(0.35, 1 - lifted * 0.3) * look.size;

      for (let i = -2; i <= 2; i += 1) {
        for (let j = -1; j <= 1; j += 1) {
          const lx = i * 0.52 * spread;
          const lz = j * 0.5 * spread;
          out.push(
            look.x + cos * lx - sin * lz,
            0.06,
            look.z + sin * lx + cos * lz,
            0,
            1,
            0,
            0.42 * spread,
            SHADOW,
            SHADOW_FLAGS,
          );
        }
      }
    }

    const white = look.flash > 0 && Math.floor(look.flash * 30) % 2 === 0;

    const place = {
      pitch: look.pitch + (look.boosting ? 0.06 : 0),
      ramp: white ? RAMP.white : this.ramp,
      roll: look.roll + this.lean,
      scale: size,
      squash: 1 - Math.sin(this.squash * Math.PI) * 0.22,
      x: look.x,
      y: look.y + 0.05,
      yaw,
      z: look.z,
    };

    drawSplats(out, BODY, place);
    const set = BUMPERS[look.bumperLook];
    const reach = (1.36 + look.bumper) * size;

    if (look.bumper > 0.25) {
      for (let k = 0.4; k < look.bumper; k += 0.5) {
        const at = (1.3 + k) * size;
        drawSplats(out, COIL_LINK, { ...place, x: look.x + cos * at, z: look.z + sin * at });
      }
    }

    drawSplats(out, look.ready ? set.armed : set.spent, {
      ...place,
      x: look.x + cos * reach,
      z: look.z + sin * reach,
    });
  }
}
