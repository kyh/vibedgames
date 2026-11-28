import type * as THREE from "three";

import { FLAG, MeshBuilder } from "../pixel/mesh-builder";
import type { Coat } from "../pixel/mesh-builder";
import { BASE, RAMP, TEAM_RAMP, tone } from "../pixel/palette";
import type { PixelStage } from "../pixel/stage";
import { CRATE_BEAM } from "../shared/constants";
import type { ItemKind } from "../shared/constants";
import type { Arena, HazardDef } from "../sim/arena";
import { HEAD_HALF, pistonAt, sweeperAngle } from "../sim/hazards";
import type { Crate } from "../sim/items";
import type { LightMap } from "./light-map";

const wrap = (v: number, period: number) => ((v % period) + period) % period;

const STRIPES: Coat = {
  at: (x, _y, z) => (wrap(x + z * 0.8, 1.5) < 0.75 ? tone(RAMP.iron, BASE - 1) : -1),
  tone: tone(RAMP.hazard, BASE),
};

const bake = (build: (b: MeshBuilder) => void) => {
  const builder = new MeshBuilder();
  build(builder);

  return builder.build();
};

const arm = (length: number) =>
  bake((b) => {
    b.part();
    b.box(0, 0.78, 0, length * 2, 0.7, 1, STRIPES);

    for (const end of [-length, length]) {
      b.part();
      b.cylinder(end, 0.85, 0, 0.78, 1.1, { tone: tone(RAMP.red, BASE) });
      b.cylinder(end, 1.44, 0, 0.5, 0.1, { tone: tone(RAMP.red, BASE + 2) });
    }

    b.part();
    b.cylinder(0, 0.2, 0, 1.5, 0.4, { tone: tone(RAMP.iron, BASE - 1) });
    b.part();
    b.cylinder(0, 0.85, 0, 1.2, 1.3, { tone: tone(RAMP.iron, BASE + 1) });
    b.part();
    b.cylinder(0, 1.58, 0, 0.8, 0.18, { tone: tone(RAMP.hazard, BASE + 1) });
    b.cylinder(0, 1.72, 0, 0.28, 0.12, { tone: tone(RAMP.iron, BASE - 1) });
  });

const HEAD = bake((b) => {
  b.part();
  b.box(0, 0.95, 0, 1.1, 1.7, HEAD_HALF * 2, STRIPES);
  b.part();
  b.box(0.6, 0.95, 0, 0.14, 1.4, HEAD_HALF * 2 - 0.4, { tone: tone(RAMP.red, BASE) });
});

const ROD = bake((b) => {
  b.part();
  b.box(0, 0.9, 0, 1, 0.46, 0.6, {
    at: (x) => (wrap(x, 0.5) < 0.12 ? tone(RAMP.steel, BASE - 2) : -1),
    tone: tone(RAMP.steel, BASE + 1),
  });
});

const popBumper = (r: number) =>
  bake((b) => {
    b.part();
    b.cylinder(0, 0.14, 0, r * 1.14, 0.28, { tone: tone(RAMP.iron, BASE) });
    b.part();
    b.cylinder(0, 0.66, 0, r, 0.9, {
      at: (x, _y, z) =>
        wrap(Math.atan2(z, x), Math.PI / 4) < Math.PI / 8 ? tone(RAMP.cream, BASE + 1) : -1,
      tone: tone(RAMP.pink, BASE),
    });
    b.part();
    b.cylinder(0, 1.18, 0, r * 1.06, 0.16, { tone: tone(RAMP.cream, BASE + 2) });
    b.part();
    b.cone(0, 1.36, 0, r * 0.7, r * 0.5, 0.22, { tone: tone(RAMP.pink, BASE + 1) });
  });

/** A column of light in whatever colour it is drawn in: something is coming down here. */
export const BEAM = bake((b) => {
  b.part();
  b.box(0, 9, 0, 0.7, 18, 0.7, {
    flags: FLAG.unlit + FLAG.noShadow + FLAG.noOutline,
    tone: tone(TEAM_RAMP, BASE + 2),
  });
  b.box(0, 9, 0, 0.3, 18, 0.3, {
    flags: FLAG.unlit + FLAG.noShadow + FLAG.noOutline,
    tone: tone(TEAM_RAMP, BASE + 3),
  });
});

/** The ramp each item wears: its crate, its beam, its name on the HUD. */
export const ITEM_RAMP = {
  giant: RAMP.green,
  mega: RAMP.red,
  spring: RAMP.blue,
  turbo: RAMP.yellow,
} as const satisfies Record<ItemKind, number>;

const MARKS: Record<ItemKind, (x: number, z: number) => boolean> = {
  giant: (x, z) => Math.abs(x) < 0.16 || Math.abs(z) < 0.16,
  mega: (x, z) => Math.abs(x) < 0.36 && Math.abs(z) < 0.36,
  spring: (x, z) => wrap(x + Math.abs(wrap(z * 2, 1) - 0.5) * 0.6, 0.5) < 0.2,
  turbo: (x, z) =>
    Math.abs(Math.abs(z) + x * 0.9 - 0.25) < 0.14 || Math.abs(Math.abs(z) + x * 0.9 + 0.3) < 0.12,
};

const crate = (kind: ItemKind) =>
  bake((b) => {
    const ramp = ITEM_RAMP[kind];
    b.part();
    b.box(0, 0.75, 0, 1.5, 1.5, 1.5, {
      at: (x, y, z) => {
        const lid = y > 1.45;
        const across = Math.max(Math.abs(x), Math.abs(z));
        const frame = lid ? across > 0.58 : across > 0.58 && Math.abs(y - 0.75) > 0.56;
        const post = !lid && Math.min(Math.abs(x), Math.abs(z)) > 0.56;

        if (frame || post) {
          return tone(RAMP.cream, BASE + 1);
        }

        if (lid) {
          return MARKS[kind](x, z) ? tone(RAMP.cream, 7) : -1;
        }

        return Math.abs(Math.abs(x) - Math.abs(z) + (y - 0.75)) < 0.1 ? tone(ramp, BASE - 1) : -1;
      },
      tone: tone(ramp, BASE),
    });
  });

const CRATES = {
  giant: crate("giant"),
  mega: crate("mega"),
  spring: crate("spring"),
  turbo: crate("turbo"),
} satisfies Record<ItemKind, THREE.BufferGeometry>;

interface Prop {
  hazard: HazardDef;
  model: THREE.BufferGeometry | null;
  sinceRung: number;
}

const drawPiston = (
  stage: PixelStage,
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
    stage.draw(ROD, {
      x: hazard.x + fx * along,
      y: 0,
      yaw: hazard.a,
      z: hazard.z + fz * along,
    });
  }

  stage.draw(HEAD, {
    x: hazard.x + fx * head,
    y: 0,
    yaw: hazard.a,
    z: hazard.z + fz * head,
  });

  if (time >= 0 && state.warn > 0) {
    const blink = Math.floor(clock * (6 + state.warn * 10)) % 2 === 0;

    for (let along = 2.6; along < hazard.reach + 1.2; along += 1.3) {
      lights.pool(hazard.x + fx * along, hazard.z + fz * along, 2.2, 0.2 + state.warn * 0.45);

      if (blink) {
        for (const side of [-1.9, 1.9]) {
          stage.dabs.push(
            hazard.x + fx * along - fz * side,
            0.08,
            hazard.z + fz * along + fx * side,
            0.34,
            tone(RAMP.red, BASE + 1),
            true,
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
  draw(stage: PixelStage, lights: LightMap, time: number, clock: number, dt: number) {
    for (const prop of this.props) {
      const { hazard, model } = prop;
      prop.sinceRung += dt;

      if (hazard.kind === "sweeper" && model) {
        const yaw = sweeperAngle(hazard, Math.max(0, time));
        stage.draw(model, { x: hazard.x, y: 0, yaw, z: hazard.z });
      } else if (hazard.kind === "bumper" && model) {
        const k = Math.max(0, 1 - prop.sinceRung / 0.25);
        stage.draw(model, {
          scale: 1 + k * 0.25,
          squash: 1 - k * 0.3,
          x: hazard.x,
          y: 0,
          yaw: 0,
          z: hazard.z,
        });

        if (k > 0) {
          lights.pool(hazard.x, hazard.z, 3.4 + k * 2, k * 0.6);
        }
      } else if (hazard.kind === "piston") {
        drawPiston(stage, lights, hazard, time, clock);
      }
    }
  }
}

/** A crate, or the beam that says one is coming. */
export const drawCrate = (
  stage: PixelStage,
  lights: LightMap,
  item: Crate,
  time: number,
  clock: number,
) => {
  const ramp = ITEM_RAMP[item.kind];
  const until = item.landAt - time;

  if (until > 0) {
    const k = 1 - until / CRATE_BEAM;

    stage.draw(BEAM, {
      ramp,
      scale: 0.6 + k * 0.9,
      sheer: true,
      squash: 1 / (0.6 + k * 0.9),
      x: item.x,
      y: 0,
      yaw: 0,
      z: item.z,
    });

    lights.pool(item.x, item.z, 1.6 + k * 2, 0.3 + k * 0.4);

    if (until < 0.35) {
      stage.draw(CRATES[item.kind], {
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
  stage.draw(CRATES[item.kind], {
    squash: 1 - landed * 0.3,
    x: item.x,
    y: 0.25 + bob,
    yaw: Math.round(clock * 0.9 * 8) / 8,
    z: item.z,
  });
};
