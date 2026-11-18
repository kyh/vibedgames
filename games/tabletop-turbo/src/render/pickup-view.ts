import { BLOT_RADIUS, BOMB_FLIGHT } from "../shared/constants";
import type { Field } from "../sim/pickups";
import { SplatBuilder } from "../splat/builder";
import { drawSplats } from "../splat/draw";
import { RAMP, TEAM_RAMP } from "../splat/palette";
import { FLAG, SplatSet, tone } from "../splat/splat-set";

/** A paint bomb in the air. */
export interface Bomb {
  by: string;
  ramp: number;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  /** Scene clock at the throw. */
  t0: number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const GLINT = tone(RAMP.white, 4);

const orbModel = () => {
  const b = new SplatBuilder(0.3, new SplatSet(256), 3);
  b.sphere(0, 0, 0, 0.62, { flags: FLAG.pulse, tone: tone(RAMP.yellow, 2) });

  return b.set;
};

const crateModel = () => {
  const b = new SplatBuilder(0.3, new SplatSet(512), 5);
  const trim = tone(RAMP.yellow, 2);
  b.box(0, 0, 0, 1.5, 1.5, 1.5, {
    at: (x, y, z) => {
      const bands = [Math.abs(x), Math.abs(y), Math.abs(z)].filter((v) => v < 0.2).length;

      return bands > 0 ? trim : -1;
    },
    flags: FLAG.pulse,
    tone: tone(RAMP.white, 3),
  });

  return b.set;
};

const blotModel = () => {
  const b = new SplatBuilder(0.3, new SplatSet(256), 9);
  const count = Math.round((Math.PI * BLOT_RADIUS * BLOT_RADIUS) / 0.09);

  for (let i = 0; i < count; i += 1) {
    const d = BLOT_RADIUS * Math.sqrt((i + 0.5) / count);
    const step = d > BLOT_RADIUS * 0.8 ? 2 : 0;
    b.dab(Math.cos(i * GOLDEN) * d, 0, Math.sin(i * GOLDEN) * d, 0, 1, 0, {
      flags: FLAG.unlit + FLAG.noShadow,
      tone: tone(RAMP.black, step),
    });
  }

  return b.set;
};

const bombModel = () => {
  const b = new SplatBuilder(0.22, new SplatSet(256), 13);
  b.sphere(0, 0, 0, 0.8, { flags: FLAG.unlit, tone: tone(TEAM_RAMP, 3) });

  return b.set;
};

export class PickupView {
  private readonly orb = orbModel();
  private readonly crate = crateModel();
  private readonly blot = blotModel();
  private readonly bomb = bombModel();
  private field: Field | null = null;
  private bombs: readonly Bomb[] = [];
  private time = 0;

  update(field: Field, bombs: readonly Bomb[], time: number) {
    this.field = field;
    this.bombs = bombs;
    this.time = time;
  }

  /** Stamp every pickup within `reach` of (cx, cz): the rest are off screen. */
  draw(out: SplatSet, cx: number, cz: number, reach: number) {
    const { field, time } = this;

    if (!field) {
      return;
    }

    const near = (spot: { x: number; z: number }) =>
      Math.abs(spot.x - cx) < reach && Math.abs(spot.z - cz) < reach;

    for (const [i, orb] of field.orbs.entries()) {
      if (time >= orb.until && near(orb)) {
        const y = 1.3 + Math.sin(time * 3 + i) * 0.16;
        drawSplats(out, this.orb, { x: orb.x, y, yaw: 0, z: orb.z });
        const hop = (Math.floor(time * 6 + i) % 4) * (Math.PI / 2);
        out.push(
          orb.x + Math.cos(hop) * 0.7,
          y + 0.5,
          orb.z + Math.sin(hop) * 0.7,
          0,
          1,
          0,
          0.2,
          GLINT,
          FLAG.unlit + FLAG.round + FLAG.noShadow,
        );
      }
    }

    for (const [i, box] of field.boxes.entries()) {
      if (time >= box.until && near(box)) {
        const back = Math.min(1, Math.max(0, (time - box.until) * 3));
        drawSplats(out, this.crate, {
          scale: 0.6 + 0.4 * back + Math.sin(back * Math.PI) * 0.12,
          x: box.x,
          y: 1.5 + Math.sin(time * 2 + i * 1.7) * 0.14,
          yaw: (Math.floor(time * 4 + i * 3) * Math.PI) / 8,
          z: box.z,
        });
      }
    }

    for (const blot of field.blots) {
      const scale = Math.min(1, Math.max(0.05, (blot.until - time) / 2));
      drawSplats(out, this.blot, { scale, x: blot.x, y: 0.26, yaw: 0, z: blot.z });
    }

    for (const bomb of this.bombs) {
      const k = Math.min(1, (time - bomb.t0) / BOMB_FLIGHT);
      drawSplats(out, this.bomb, {
        ramp: bomb.ramp,
        x: bomb.fromX + (bomb.toX - bomb.fromX) * k,
        y: 1.2 + Math.sin(k * Math.PI) * 7,
        yaw: 0,
        z: bomb.fromZ + (bomb.toZ - bomb.fromZ) * k,
      });
    }
  }
}
