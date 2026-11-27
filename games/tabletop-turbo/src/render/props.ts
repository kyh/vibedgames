import { CRATE_BEAM } from "../shared/constants";
import type { ItemKind } from "../shared/constants";
import type { Arena, HazardDef } from "../sim/arena";
import { HEAD_HALF, pistonAt, sweeperAngle } from "../sim/hazards";
import type { Crate } from "../sim/items";
import { SplatBuilder } from "../splat/builder";
import type { Coat } from "../splat/builder";
import { drawSplats } from "../splat/draw";
import { RAMP } from "../splat/palette";
import { FLAG, SplatSet, tone } from "../splat/splat-set";
import type { LightMap } from "./light-map";

const SPACING = 0.2;
const BRIGHT = FLAG.bright;
const GLOW = FLAG.unlit + FLAG.round + FLAG.noShadow;

const wrap = (v: number, period: number) => ((v % period) + period) % period;

const STRIPES: Coat = {
  at: (x, _y, z) => (wrap(x + z * 0.8, 1.6) < 0.8 ? tone(RAMP.black, 1) : -1),
  flags: BRIGHT,
  tone: tone(RAMP.hazard, 2),
};

const bake = (build: (b: SplatBuilder) => void, seed: number, spacing = SPACING) => {
  const builder = new SplatBuilder(spacing, new SplatSet(2048), seed);
  build(builder);

  return builder.set;
};

const arm = (length: number) =>
  bake((b) => {
    b.box(0, 0.75, 0, length * 2, 0.7, 1, STRIPES);
    b.cylinder(0, 0.7, 0, 1.25, 1.4, { flags: BRIGHT, tone: tone(RAMP.black, 2) });
    b.cylinder(0, 1.45, 0, 0.7, 0.2, { flags: FLAG.unlit, tone: tone(RAMP.hazard, 3) });
    b.cylinder(length, 0.8, 0, 0.75, 1, { flags: BRIGHT, tone: tone(RAMP.red, 2) });
    b.cylinder(-length, 0.8, 0, 0.75, 1, { flags: BRIGHT, tone: tone(RAMP.red, 2) });
  }, 61);

const HEAD = bake((b) => {
  b.box(0, 0.95, 0, 1.1, 1.7, HEAD_HALF * 2, STRIPES);
  b.box(0.58, 0.95, 0, 0.12, 1.3, HEAD_HALF * 2 - 0.5, { flags: BRIGHT, tone: tone(RAMP.red, 2) });
}, 62);

const ROD = bake((b) => {
  b.box(0, 0.9, 0, 1, 0.5, 0.6, { flags: BRIGHT, tone: tone(RAMP.white, 1) });
}, 63);

const popBumper = (r: number) =>
  bake((b) => {
    b.cylinder(0, 0.55, 0, r, 1.1, { flags: BRIGHT, tone: tone(RAMP.pink, 2) });
    b.cylinder(0, 1.15, 0, r * 0.72, 0.14, { flags: FLAG.unlit, tone: tone(RAMP.cream, 4) });
    b.cylinder(0, 1.24, 0, r * 0.34, 0.1, { flags: BRIGHT, tone: tone(RAMP.pink, 3) });
  }, 64);

/** The ramp each item wears: its crate, its beam, its name on the HUD. */
export const ITEM_RAMP = {
  giant: RAMP.green,
  mega: RAMP.red,
  spring: RAMP.blue,
  turbo: RAMP.yellow,
} as const satisfies Record<ItemKind, number>;

const MARKS: Record<ItemKind, (x: number, z: number) => boolean> = {
  giant: (x, z) => Math.abs(x) < 0.2 || Math.abs(z) < 0.2,
  mega: (x, z) => Math.abs(x) < 0.42 && Math.abs(z) < 0.42,
  spring: (x, z) => wrap(x + Math.abs(wrap(z * 2, 1) - 0.5) * 0.6, 0.5) < 0.22,
  turbo: (x, z) =>
    Math.abs(Math.abs(z) + x * 0.9 - 0.25) < 0.16 || Math.abs(Math.abs(z) + x * 0.9 + 0.3) < 0.14,
};

const crate = (kind: ItemKind) =>
  bake(
    (b) => {
      const ramp = ITEM_RAMP[kind];
      b.box(0, 0.75, 0, 1.5, 1.5, 1.5, {
        at: (x, y, z) => {
          const rim =
            Math.max(Math.abs(x), Math.abs(z)) > 0.6 || (y < 1.45 && Math.abs(y - 0.75) > 0.6);

          if (rim) {
            return tone(RAMP.cream, 3);
          }

          return y > 1.45 && MARKS[kind](x, z) ? tone(RAMP.cream, 4) : -1;
        },
        flags: FLAG.unlit,
        tone: tone(ramp, 2),
      });
    },
    70,
    0.15,
  );

const CRATES = {
  giant: crate("giant"),
  mega: crate("mega"),
  spring: crate("spring"),
  turbo: crate("turbo"),
} satisfies Record<ItemKind, SplatSet>;

interface Prop {
  hazard: HazardDef;
  model: SplatSet | null;
  sinceRung: number;
}

const drawPiston = (
  out: SplatSet,
  lights: LightMap,
  hazard: Extract<HazardDef, { kind: "piston" }>,
  time: number,
  clock: number,
) => {
  const state = pistonAt(hazard, Math.max(0, time));
  const fx = Math.cos(hazard.a);
  const fz = Math.sin(hazard.a);
  const head = 0.9 + state.out * hazard.reach;

  for (let along = 1.6; along < head - 0.6; along += 1) {
    drawSplats(out, ROD, {
      x: hazard.x + fx * along,
      y: 0,
      yaw: hazard.a,
      z: hazard.z + fz * along,
    });
  }

  drawSplats(out, HEAD, {
    x: hazard.x + fx * head,
    y: 0,
    yaw: hazard.a,
    z: hazard.z + fz * head,
  });

  if (time >= 0 && state.warn > 0) {
    const blink = Math.floor(clock * (6 + state.warn * 10)) % 2 === 0;

    for (let along = 2; along < hazard.reach + 1.2; along += 1.3) {
      lights.pool(hazard.x + fx * along, hazard.z + fz * along, 2.4, 0.25 + state.warn * 0.5);

      if (blink) {
        for (const side of [-1.72, 1.72]) {
          out.push(
            hazard.x + fx * along - fz * side,
            0.08,
            hazard.z + fz * along + fx * side,
            0,
            1,
            0,
            0.3,
            tone(RAMP.hazard, 4),
            GLOW,
          );
        }
      }
    }
  }
};

const modelFor = (hazard: HazardDef) => {
  if (hazard.kind === "sweeper") {
    return arm(hazard.length);
  }

  return hazard.kind === "bumper" ? popBumper(hazard.r) : null;
};

/** Everything on the board that moves but is not a car: the toys and the crates. */
export class Props {
  private readonly props: Prop[];

  constructor(arena: Arena) {
    this.props = arena.def.hazards.map((hazard) => ({
      hazard,
      model: modelFor(hazard),
      sinceRung: 9,
    }));
  }

  /** A pop bumper near (x, z) was hit: it squashes and rings. */
  ring(x: number, z: number) {
    for (const prop of this.props) {
      if (Math.hypot(prop.hazard.x - x, prop.hazard.z - z) < 5 && prop.hazard.kind === "bumper") {
        prop.sinceRung = 0;
      }
    }
  }

  /** Draw the toys as they stand at `time` seconds into the round, and the light they throw. */
  draw(out: SplatSet, lights: LightMap, time: number, clock: number, dt: number) {
    for (const prop of this.props) {
      const { hazard, model } = prop;
      prop.sinceRung += dt;

      if (hazard.kind === "sweeper" && model) {
        const yaw = sweeperAngle(hazard, Math.max(0, time));
        drawSplats(out, model, { x: hazard.x, y: 0, yaw, z: hazard.z });
        lights.pool(hazard.x, hazard.z, 3.2, 0.5);
      } else if (hazard.kind === "bumper" && model) {
        const k = Math.max(0, 1 - prop.sinceRung / 0.25);
        drawSplats(out, model, {
          scale: 1 + k * 0.25,
          squash: 1 - k * 0.3,
          x: hazard.x,
          y: 0,
          yaw: 0,
          z: hazard.z,
        });
        lights.pool(hazard.x, hazard.z, 3.4 + k * 2, 0.45 + k * 0.5);
      } else if (hazard.kind === "piston") {
        drawPiston(out, lights, hazard, time, clock);
      }
    }
  }
}

/** A crate, or the beam that says one is coming. */
export const drawCrate = (
  out: SplatSet,
  lights: LightMap,
  item: Crate,
  time: number,
  clock: number,
) => {
  const ramp = ITEM_RAMP[item.kind];
  const until = item.landAt - time;

  if (until > 0) {
    const k = 1 - until / CRATE_BEAM;

    for (let y = 0.4; y < 16; y += 0.55) {
      const wobble = Math.sin(y * 1.7 + clock * 9) * 0.12;
      out.push(item.x + wobble, y, item.z, 0, 1, 0, 0.16 + k * 0.2, tone(ramp, 3), GLOW);
    }

    lights.pool(item.x, item.z, 2 + k * 2.5, 0.4 + k * 0.5);

    if (until < 0.35) {
      drawSplats(out, CRATES[item.kind], {
        x: item.x,
        y: (until / 0.35) * 14,
        yaw: 0,
        z: item.z,
      });
    }

    return;
  }

  const bob = Math.sin(clock * 3.2) * 0.14;
  const landed = Math.max(0, 1 - -until / 0.2);
  drawSplats(out, CRATES[item.kind], {
    squash: 1 - landed * 0.3,
    x: item.x,
    y: 0.25 + bob,
    yaw: Math.round(clock * 0.9 * 8) / 8,
    z: item.z,
  });
  lights.pool(item.x, item.z, 3.6, 0.7);
};
