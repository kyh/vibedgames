import type * as THREE from "three";

import { FLAG, MeshBuilder } from "../pixel/mesh-builder";
import type { Coat } from "../pixel/mesh-builder";
import { BASE, RAMP, TEAM_RAMP, tone } from "../pixel/palette";
import type { PixelStage } from "../pixel/stage";
import { CUBE_BEAM } from "../shared/constants";
import type { Arena, HazardDef } from "../sim/arena";
import type { Cube } from "../sim/cubes";
import { HEAD_HALF, hazardGone, pistonAt, sweeperAngle } from "../sim/hazards";
import type { Shot } from "../sim/shots";
import { MINE_ARM, OIL_RADIUS } from "../sim/specials";
import type { SpecialKind } from "../sim/specials";
import type { GlowGrid } from "./glow-grid";
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

/** The arrow that hangs over your own car: a plate that faces the camera. */
export const ARROW = bake((b) => {
  const cream = { flags: FLAG.unlit + FLAG.noShadow, tone: tone(RAMP.cream, 7) };
  b.part();
  b.patch([-0.7, 1.5, 0], [0.7, 1.5, 0], [0, 0, 0], [0, 0, 0], [0, 0, 1], cream);
});

/** The turntable the title shows a car on. */
export const PODIUM = bake((b) => {
  b.part();
  b.cylinder(0, 0.2, 0, 4.4, 0.4, { tone: tone(RAMP.iron, BASE - 1) });
  b.part();
  b.cylinder(0, 0.6, 0, 4, 0.4, {
    at: (x, y, z) => {
      if (y < 0.78) {
        return wrap(Math.atan2(z, x), Math.PI / 6) < Math.PI / 12 ? tone(RAMP.hazard, BASE) : -1;
      }

      const r = Math.hypot(x, z);

      return r > 3.5 || (r > 2.2 && r < 2.4) ? tone(RAMP.cream, BASE + 2) : -1;
    },
    tone: tone(RAMP.tile, BASE),
  });
});

/** The ramp each special wears: its sparks, its name on the HUD, what it lets go. */
export const SPECIAL_RAMP = {
  giant: RAMP.green,
  magnet: RAMP.pink,
  mine: RAMP.hazard,
  oil: RAMP.purple,
  rocket: RAMP.red,
  seeker: RAMP.orange,
  shield: RAMP.blue,
  shock: RAMP.cyan,
  spring: RAMP.lime,
  turbo: RAMP.yellow,
  wrench: RAMP.chalk,
  zap: RAMP.yellow,
} as const satisfies Record<SpecialKind, number>;

/** The paint slot an oil slick is laid in. */
export const OIL_SLOT = 30;

const CUBE_RAMPS = [RAMP.yellow, RAMP.pink, RAMP.cyan, RAMP.lime, RAMP.orange] as const;

const mark = (x: number, y: number) => {
  const hook = y > 0.24 && Math.hypot(x, y - 0.24) < 0.34 && Math.hypot(x, y - 0.24) > 0.17;
  const cut = hook && !(x < 0 && y < 0.3);
  const stem = Math.abs(x) < 0.09 && y > -0.16 && y < 0.1;
  const dot = Math.abs(x) < 0.09 && y > -0.42 && y < -0.26;

  return cut || stem || dot;
};

const CUBE = bake((b) => {
  const lit = FLAG.unlit;
  b.part();
  b.box(0, 0.85, 0, 1.5, 1.5, 1.5, {
    at: (x, y, z) => {
      const u = Math.abs(x) > 0.74 ? z : x;
      const top = y > 1.59;
      const edge = Math.max(Math.abs(top ? x : u), Math.abs(top ? z : y - 0.85)) > 0.6;

      if (edge) {
        return tone(RAMP.cream, 7);
      }

      return mark(top ? x : u, top ? -z : y - 0.85) ? tone(RAMP.cream, 7) : -1;
    },
    flags: lit,
    tone: tone(TEAM_RAMP, BASE + 1),
  });
});

const PUCK = bake((b) => {
  b.part();
  b.cylinder(0, 0.7, 0, 0.5, 0.34, { tone: tone(TEAM_RAMP, BASE + 1) });
  b.part();
  b.cylinder(0, 0.9, 0, 0.26, 0.08, { flags: FLAG.unlit, tone: tone(RAMP.cream, 7) });
});

const missile = (body: number, long: number) =>
  bake((b) => {
    b.part();
    b.cylinder(0, 0.9, 0, 0.3, long, { tone: tone(RAMP.cream, BASE + 1) }, "x");
    b.part();
    b.cone(long / 2 + 0.3, 0.9, 0, 0.3, 0.04, 0.6, { tone: tone(body, BASE) }, "x");
    b.part();
    b.box(-long / 2 + 0.1, 0.9, 0, 0.5, 0.08, 1.1, { tone: tone(body, BASE) });
    b.box(-long / 2 + 0.1, 1.2, 0, 0.5, 0.56, 0.08, { tone: tone(body, BASE) });
    b.part();
    b.cylinder(
      -long / 2 - 0.1,
      0.9,
      0,
      0.2,
      0.2,
      { flags: FLAG.unlit, tone: tone(RAMP.hazard, 7) },
      "x",
    );
  });

const ROCKET = missile(RAMP.red, 1.5);
const SEEKER = missile(RAMP.orange, 1);

const mine = (armed: boolean) =>
  bake((b) => {
    b.part();
    b.cylinder(0, 0.22, 0, 0.95, 0.44, {
      at: (x, _y, z) =>
        wrap(Math.atan2(z, x), Math.PI / 3) < Math.PI / 6 ? tone(RAMP.hazard, BASE) : -1,
      tone: tone(RAMP.iron, BASE - 1),
    });
    b.part();
    b.cylinder(0, 0.52, 0, 0.42, 0.2, {
      flags: armed ? FLAG.unlit : 0,
      tone: tone(RAMP.red, armed ? BASE + 3 : BASE - 1),
    });
  });

const MINE = { armed: mine(true), idle: mine(false) };

interface Prop {
  hazard: HazardDef;
  model: THREE.BufferGeometry | null;
  sinceRung: number;
  rim: boolean;
}

const drawPiston = (
  stage: PixelStage,
  lights: LightMap,
  hazard: Extract<HazardDef, { kind: "piston" }>,
  time: number,
  clock: number,
  drop: number,
) => {
  const state = pistonAt(hazard, Math.max(0, time));
  const fx = Math.cos(hazard.a);
  const fz = Math.sin(hazard.a);
  const head = 0.9 + (drop > 0 ? 0 : state.out) * hazard.reach;

  for (let along = 1.6; along < head - 0.6; along += 1) {
    stage.draw(ROD, {
      x: hazard.x + fx * along,
      y: -drop,
      yaw: hazard.a,
      z: hazard.z + fz * along,
    });
  }

  stage.draw(HEAD, {
    x: hazard.x + fx * head,
    y: -drop,
    yaw: hazard.a,
    z: hazard.z + fz * head,
  });

  if (time >= 0 && state.warn > 0 && drop <= 0) {
    const blink = Math.floor(clock * (6 + state.warn * 10)) % 2 === 0;

    for (let along = 2.6; along < hazard.reach + 1.2; along += 1.3) {
      lights.pool(hazard.x + fx * along, hazard.z + fz * along, 2.2, 0.1 + state.warn * 0.2);

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

/** The toys on the board: the sweeper, the pop bumpers and the pistons. */
export class Props {
  private readonly props: Prop[];

  constructor(arena: Arena) {
    this.props = arena.def.hazards.map((hazard) => ({
      hazard,
      model: modelFor(hazard),
      rim: hazardGone(arena, hazard, true),
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

  /**
   * Draw the toys as they stand at `time` seconds into the round, and the light
   * they throw. `drop` is how far the rim has fallen, and its toys with it.
   */
  draw(stage: PixelStage, lights: LightMap, time: number, clock: number, dt: number, drop: number) {
    for (const prop of this.props) {
      const { hazard, model } = prop;
      const down = prop.rim ? drop : 0;
      prop.sinceRung += dt;

      const here = down <= 60;

      if (hazard.kind === "sweeper" && model && here) {
        const yaw = sweeperAngle(hazard, Math.max(0, time));
        stage.draw(model, { x: hazard.x, y: -down, yaw, z: hazard.z });
      } else if (hazard.kind === "bumper" && model && here) {
        const k = Math.max(0, 1 - prop.sinceRung / 0.25);
        stage.draw(model, {
          scale: 1 + k * 0.25,
          squash: 1 - k * 0.3,
          x: hazard.x,
          y: -down,
          yaw: 0,
          z: hazard.z,
        });

        if (k > 0) {
          lights.pool(hazard.x, hazard.z, 3.4 + k * 2, k * 0.6);
        }
      } else if (hazard.kind === "piston" && here) {
        drawPiston(stage, lights, hazard, time, clock, down);
      }
    }
  }
}

/** A power cube, or the beam that says one is coming. */
export const drawCube = (
  stage: PixelStage,
  lights: LightMap,
  cube: Cube,
  time: number,
  clock: number,
) => {
  const ramp = CUBE_RAMPS[(Math.floor(clock * 5) + cube.id) % CUBE_RAMPS.length] ?? RAMP.yellow;
  const until = cube.landAt - time;

  if (until > 0) {
    const k = 1 - until / CUBE_BEAM;

    stage.draw(BEAM, {
      ramp,
      scale: 0.6 + k * 0.9,
      sheer: true,
      squash: 1 / (0.6 + k * 0.9),
      x: cube.x,
      y: 0,
      yaw: 0,
      z: cube.z,
    });

    lights.pool(cube.x, cube.z, 1.6 + k * 2, 0.3 + k * 0.4);

    if (until < 0.35) {
      stage.draw(CUBE, { ramp, x: cube.x, y: (until / 0.35) * 14, yaw: 0, z: cube.z });
    }

    return;
  }

  const bob = Math.sin(clock * 3.2 + cube.id) * 0.16;
  const landed = Math.max(0, 1 - -until / 0.2);
  stage.draw(CUBE, {
    ramp,
    squash: 1 - landed * 0.3,
    x: cube.x,
    y: 0.3 + bob,
    yaw: Math.round((clock * 1.4 + cube.id) * 8) / 8,
    z: cube.z,
  });
  lights.pool(cube.x, cube.z, 2.4, 0.3);
};

const drawOil = (stage: PixelStage, glow: GlowGrid, shot: Shot, age: number) => {
  const grown = Math.min(1, age / 0.25);
  glow.stamp(shot.x, shot.z, OIL_RADIUS * grown, OIL_SLOT, 1);

  for (let i = 0; i < 5; i += 1) {
    const a = i * 2.4 + shot.x;
    const r = (0.5 + (i % 3) * 0.6) * grown;
    stage.dabs.push(
      shot.x + Math.cos(a) * r,
      0.07,
      shot.z + Math.sin(a) * r,
      0.3,
      tone(RAMP.purple, BASE + 2),
      true,
    );
  }
};

/** Anything let go on the board, drawn in its owner's colour `ramp`. */
export const drawShot = (
  stage: PixelStage,
  lights: LightMap,
  glow: GlowGrid,
  shot: Shot,
  time: number,
  clock: number,
  ramp: number,
) => {
  const age = time - shot.t0;
  const place = { ramp, x: shot.x, y: 0, yaw: shot.a, z: shot.z };

  if (shot.kind === "oil") {
    drawOil(stage, glow, shot, age);
  } else if (shot.kind === "mine") {
    const armed = age > MINE_ARM && Math.floor(clock * 4) % 2 === 0;
    stage.draw(armed ? MINE.armed : MINE.idle, {
      ...place,
      squash: 1 + Math.max(0, 0.2 - age) * 2,
    });

    if (armed) {
      lights.pool(shot.x, shot.z, 2.2, 0.4);
    }
  } else if (shot.kind === "puck") {
    stage.draw(PUCK, { ...place, yaw: clock * 20 });
    lights.pool(shot.x, shot.z, 1.6, 0.4);
  } else {
    stage.draw(shot.kind === "rocket" ? ROCKET : SEEKER, place);
    lights.pool(shot.x, shot.z, 2.6, 0.6);
  }
};
