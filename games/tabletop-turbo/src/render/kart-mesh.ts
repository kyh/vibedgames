import { SplatBuilder } from "../splat/builder";
import type { Coat } from "../splat/builder";
import { drawSplats } from "../splat/draw";
import { RAMP, TEAM_RAMP } from "../splat/palette";
import { FLAG, SplatSet, tone } from "../splat/splat-set";

/** What a kart looks like this frame. */
export interface KartLook {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** -1 … 1: leans the body into the turn. */
  steer: number;
  /** -1 / 0 / 1. */
  drift: number;
  speed: number;
  boosting: boolean;
  /** 0 … 1 through a spin-out; 0 when not spinning. */
  spin: number;
  /** Drawn this much larger than usual: the picked kart on the title screen. */
  size?: number;
}

const SIZE = 1.45;
const SHADE = tone(RAMP.track, 0);

const STRIPE = tone(RAMP.white, 3);
const body = (step: number) => ({ tone: tone(TEAM_RAMP, step) });

const striped: (step: number) => Coat = (step) => ({
  at: (_x, _y, z) => (Math.abs(z) < 0.19 ? STRIPE : -1),
  tone: tone(TEAM_RAMP, step),
});

const RUBBER: Coat = { tone: tone(RAMP.black, 1) };
const HUB: Coat = { tone: tone(RAMP.white, 3) };
const GLASS: Coat = { tone: tone(TEAM_RAMP, 0) };
const CHROME: Coat = { tone: tone(RAMP.white, 2) };

const wheels = (b: SplatBuilder, front: number, rear: number, out: number) => {
  for (const side of [-1, 1]) {
    b.cylinder(0.98, front, side * out, front, 0.4, RUBBER, "z");
    b.cylinder(0.98, front, side * (out + 0.19), front * 0.5, 0.08, HUB, "z");
    b.cylinder(-0.95, rear, side * out, rear, 0.46, RUBBER, "z");
    b.cylinder(-0.95, rear, side * (out + 0.22), rear * 0.5, 0.08, HUB, "z");
  }
};

const dart = (b: SplatBuilder) => {
  wheels(b, 0.4, 0.46, 0.66);
  b.box(0, 0.52, 0, 3, 0.34, 1.2, striped(2));
  b.box(0.85, 0.76, 0, 1.1, 0.16, 1.05, striped(2));
  b.box(-0.2, 0.92, 0, 1.05, 0.46, 0.96, GLASS);
  b.box(-0.2, 1.2, 0, 0.9, 0.1, 0.86, striped(3));
  b.box(-1.38, 1.24, 0, 0.34, 0.1, 1.44, body(1));
  b.box(-1.38, 0.95, 0.5, 0.12, 0.5, 0.1, body(1));
  b.box(-1.38, 0.95, -0.5, 0.12, 0.5, 0.1, body(1));
};

const anvil = (b: SplatBuilder) => {
  wheels(b, 0.42, 0.58, 0.72);
  b.box(0, 0.6, 0, 3.1, 0.44, 1.3, body(2));
  b.box(-0.7, 1.06, 0, 1.1, 0.5, 1.1, GLASS);
  b.box(-0.7, 1.36, 0, 1.2, 0.12, 1.2, body(3));
  b.box(0.75, 0.98, 0, 0.9, 0.34, 0.7, CHROME);
  b.cylinder(0.75, 1.3, 0.18, 0.16, 0.34, CHROME);
  b.cylinder(0.75, 1.3, -0.18, 0.16, 0.34, CHROME);
  b.cylinder(-0.4, 0.5, 0.74, 0.11, 1.9, CHROME, "x");
  b.cylinder(-0.4, 0.5, -0.74, 0.11, 1.9, CHROME, "x");
};

const wisp = (b: SplatBuilder) => {
  wheels(b, 0.38, 0.44, 0.78);
  b.box(-0.2, 0.5, 0, 2.2, 0.3, 0.86, striped(2));
  b.cone(1.25, 0.5, 0, 0.36, 0.12, 1, striped(2), "x");
  b.sphere(-0.1, 0.78, 0, 0.5, GLASS, 0.8);
  b.box(-1.3, 1.02, 0, 0.3, 0.08, 1.5, body(3));
  b.box(-1.3, 0.8, 0, 0.12, 0.4, 0.12, body(1));
  b.box(1.5, 0.34, 0, 0.26, 0.06, 1.5, body(3));
};

const CHASSIS_BUILDS = [dart, anvil, wisp] as const;
const MODELS = new Map<number, SplatSet>();

const modelFor = (chassis: number) => {
  const known = MODELS.get(chassis);

  if (known) {
    return known;
  }

  const builder = new SplatBuilder(0.15, new SplatSet(1024), 11 + chassis);
  (CHASSIS_BUILDS[chassis] ?? dart)(builder);
  MODELS.set(chassis, builder.set);

  return builder.set;
};

export class KartMesh {
  visible = true;
  private readonly ramp: number;
  private readonly model: SplatSet;
  private readonly mono: boolean;
  private look: KartLook | null = null;
  private lean = 0;
  private hop = 0;
  private squash = 0;

  constructor(ramp: number, chassis = 0, mono = false) {
    this.ramp = ramp;
    this.mono = mono;
    this.model = modelFor(chassis);
  }

  /** A little jump: the start of a drift. */
  kick() {
    this.hop = 1;
  }

  /** A hit: squash down and spring back. */
  thump() {
    this.squash = 1;
  }

  update(look: KartLook, dt: number) {
    this.look = look;
    const lean = look.drift === 0 ? look.steer * 0.08 : look.drift * 0.2;
    this.lean += (lean - this.lean) * Math.min(1, dt * 10);
    this.hop = Math.max(0, this.hop - dt * 4.5);
    this.squash = Math.max(0, this.squash - dt * 5);
  }

  draw(out: SplatSet) {
    const { look } = this;

    if (!look || !this.visible) {
      return;
    }

    const yaw = look.heading + look.drift * 0.38;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);

    for (let i = -2; i <= 2; i += 1) {
      for (let j = -1; j <= 1; j += 1) {
        const lx = i * 0.95;
        const lz = j * 0.85;
        out.push(
          look.x + cos * lx - sin * lz,
          look.y + 0.24,
          look.z + sin * lx + cos * lz,
          0,
          1,
          0,
          0.62,
          SHADE,
          FLAG.unlit + FLAG.noShadow,
        );
      }
    }

    drawSplats(out, this.model, {
      mono: this.mono,
      pitch: look.boosting ? 0.07 : 0,
      ramp: this.squash > 0 && Math.floor(this.squash * 8) % 2 === 1 ? RAMP.white : this.ramp,
      roll: this.lean,
      scale: SIZE * (look.size ?? 1),
      squash: 1 - Math.sin(this.squash * Math.PI) * 0.25,
      x: look.x,
      y: look.y + 0.2 + Math.sin(this.hop * Math.PI) * 0.5,
      yaw: look.heading + look.drift * 0.38 + look.spin * Math.PI * 4,
      z: look.z,
    });
  }
}
