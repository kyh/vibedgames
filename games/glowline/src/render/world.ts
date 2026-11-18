// The circuit as a toy set on a floor: an orange plastic track with raised
// rails, laid out in a bedroom, a kitchen or a playroom and lined with
// oversized toys. Everything is baked into one bag of splats when the circuit
// loads; only the start lamps are drawn fresh each frame.

import type { Room, Track } from "../sim/track";
import { SplatBuilder } from "../splat/builder";
import type { Coat } from "../splat/builder";
import { RAMP } from "../splat/palette";
import { FLAG, SplatSet, tone } from "../splat/splat-set";
import { FLOOR_REACH, Ground } from "./ground";
import { TOYS } from "./toys";

/** Height of the track's surface above the floor. */
export const TRACK_Y = 0.2;

const FLOOR_SPACING = 0.62;
const TRACK_SPACING = 0.34;
const TOY_SPACING = 0.38;
const RAIL_HEIGHT = 1.1;
const GANTRY_HEIGHT = 7.5;

const hash = (a: number, b: number): number => {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43_758.5453;
  return v - Math.floor(v);
};

const wrap = (v: number, period: number): number => ((v % period) + period) % period;

/** Floorboards, with a round rug in the infield. */
const bedroomFloor = (x: number, z: number): number => {
  const d = Math.hypot(x, z);
  if (d < 38) {
    if (d > 34) {
      return tone(RAMP.carpet, 3);
    }
    return tone(RAMP.carpet, hash(Math.floor(x * 2), Math.floor(z * 2)) > 0.8 ? 1 : 2);
  }
  const row = Math.floor(z / 3.4);
  const along = x + row * 7.3;
  if (wrap(z, 3.4) < 0.7 || wrap(along, 19) < 0.7) {
    return tone(RAMP.wood, 1);
  }
  return tone(RAMP.wood, hash(row, Math.floor(along / 19)) > 0.5 ? 3 : 2);
};

/** Checkerboard tiles with dark grout. */
const kitchenFloor = (x: number, z: number): number => {
  if (wrap(x, 6) < 0.7 || wrap(z, 6) < 0.7) {
    return tone(RAMP.tile, 0);
  }
  const dark = (Math.floor(x / 6) + Math.floor(z / 6)) % 2 === 0;
  return tone(RAMP.tile, dark ? 2 : 3);
};

/** Foam play-mat squares in two blues, flecked. */
const playroomFloor = (x: number, z: number): number => {
  if (wrap(x, 10) < 0.7 || wrap(z, 10) < 0.7) {
    return tone(RAMP.carpet, 0);
  }
  const light = (Math.floor(x / 10) + Math.floor(z / 10)) % 2 === 0;
  const fleck = hash(Math.floor(x * 1.5), Math.floor(z * 1.5)) > 0.9;
  if (fleck) {
    return tone(RAMP.carpet, 4);
  }
  return tone(RAMP.carpet, light ? 2 : 1);
};

const FLOORS: Record<Room, (x: number, z: number) => number> = {
  bedroom: bedroomFloor,
  kitchen: kitchenFloor,
  playroom: playroomFloor,
};

/** Shortest way round the lap from sample `from` to `s`, signed. */
const lapGap = (s: number, from: number, n: number): number => wrap(s - from + n / 2, n) - n / 2;

export class World {
  readonly set = new SplatSet(524_288);
  private readonly track: Track;
  private readonly ground: Ground;
  private readonly lamps: { x: number; z: number }[] = [];
  private lit = 0;
  private go = false;

  constructor(track: Track) {
    this.track = track;
    this.ground = new Ground(track);
    this.layFloor();
    this.layTrack();
    this.layRails();
    this.raiseGantry();
    this.raisePadGates();
    this.scatterToys();
  }

  /** How many red lamps are lit, and whether the green is on instead. */
  setStartLights(count: number, go: boolean): void {
    this.lit = count;
    this.go = go;
  }

  /** The lamps over the line: the only part of the world that changes. */
  draw(out: SplatSet): void {
    for (const [i, lamp] of this.lamps.entries()) {
      let shade = tone(RAMP.black, 1);
      if (this.go) {
        shade = tone(RAMP.green, 3);
      } else if (i < this.lit) {
        shade = tone(RAMP.red, 3);
      }
      out.push(lamp.x, GANTRY_HEIGHT - 0.9, lamp.z, 0, 1, 0, 0.5, shade, FLAG.unlit + FLAG.round);
    }
  }

  private layFloor(): void {
    const floor = FLOORS[this.track.def.palette.room];
    const b = new SplatBuilder(FLOOR_SPACING, this.set, 21);
    const under = this.track.rail - 1.5;
    for (let z = -170; z < 170; z += FLOOR_SPACING) {
      for (let x = -170; x < 170; x += FLOOR_SPACING) {
        const d = this.ground.distance(x, z);
        if (d < FLOOR_REACH && d > under) {
          const px = x + (b.random() - 0.5) * 0.25;
          const pz = z + (b.random() - 0.5) * 0.25;
          b.dab(px, 0, pz, 0, 1, 0, { tone: floor(px, pz) });
        }
      }
    }
  }

  /** The tone of the track's surface `lat` metres off the centreline at lap position `s`. */
  private surface(s: number, lat: number): number {
    const { track } = this;
    const off = Math.abs(lat);
    const half = track.halfWidth;
    if (off > half) {
      // The shoulder: a rumble strip, then darker plastic out to the rail.
      const stripe = Math.floor(s / 2) % 2 === 0 ? tone(RAMP.white, 3) : tone(RAMP.red, 2);
      return off < half + 0.9 ? stripe : tone(RAMP.track, 1);
    }
    const line = lapGap(s, 0, track.n);
    if (Math.abs(line) < 1.5) {
      const dark = (Math.floor(s) + Math.floor(lat + 100)) % 2 === 0;
      return dark ? tone(RAMP.black, 1) : tone(RAMP.white, 4);
    }
    for (const pad of track.pads) {
      const past = lapGap(s, pad, track.n);
      if (past > -1 && past < 3 && off < half * 0.75) {
        return wrap(past + off * 0.5, 1.5) < 0.75 ? tone(RAMP.yellow, 3) : tone(RAMP.black, 2);
      }
    }
    if (off < 0.24 && Math.floor(s / 3) % 2 === 0) {
      return tone(RAMP.track, 3);
    }
    if (off > half - 0.75 && off < half - 0.3) {
      return tone(RAMP.track, 4);
    }
    // Where two lengths of track click together.
    return wrap(s, 16) < 0.4 ? tone(RAMP.track, 1) : tone(RAMP.track, 2);
  }

  /** Centreline position and unit tangent at fractional lap position `s`. */
  private centre(s: number) {
    const { track } = this;
    const i = Math.floor(s) % track.n;
    const j = (i + 1) % track.n;
    const k = s - Math.floor(s);
    const tx = (track.tx[i] ?? 1) * (1 - k) + (track.tx[j] ?? 1) * k;
    const tz = (track.tz[i] ?? 0) * (1 - k) + (track.tz[j] ?? 0) * k;
    const length = Math.hypot(tx, tz) || 1;
    return {
      tx: tx / length,
      tz: tz / length,
      x: (track.xs[i] ?? 0) * (1 - k) + (track.xs[j] ?? 0) * k,
      z: (track.zs[i] ?? 0) * (1 - k) + (track.zs[j] ?? 0) * k,
    };
  }

  private layTrack(): void {
    const { track } = this;
    const b = new SplatBuilder(TRACK_SPACING, this.set, 31);
    for (let s = 0; s < track.n; s += TRACK_SPACING) {
      const at = this.centre(s);
      for (let lat = -track.rail; lat <= track.rail; lat += TRACK_SPACING) {
        const off = lat + (b.random() - 0.5) * 0.12;
        const along = (b.random() - 0.5) * 0.12;
        b.dab(
          at.x - at.tz * off + at.tx * along,
          TRACK_Y,
          at.z + at.tx * off + at.tz * along,
          0,
          1,
          0,
          {
            flags: Math.abs(off) <= track.halfWidth ? FLAG.paintable : 0,
            tone: this.surface(s, off),
          },
        );
      }
    }
  }

  /** The rail's colour at `s`: orange on the straights, red and white chevrons through a bend. */
  private railTone(s: number, step: number): number {
    const bend = Math.abs(this.track.curve[Math.floor(s) % this.track.n] ?? 0);
    if (bend > 0.018) {
      return Math.floor(s / 2.5) % 2 === 0 ? tone(RAMP.red, step) : tone(RAMP.white, step + 1);
    }
    return wrap(s, 16) < 0.6 ? tone(RAMP.white, step) : tone(RAMP.track, step);
  }

  private layRails(): void {
    const { track } = this;
    const b = new SplatBuilder(TRACK_SPACING, this.set, 41);
    const rows = Math.ceil(RAIL_HEIGHT / TRACK_SPACING);
    for (let s = 0; s < track.n; s += TRACK_SPACING) {
      const at = this.centre(s);
      for (const side of [-1, 1]) {
        const nx = -at.tz * side;
        const nz = at.tx * side;
        const inner = track.rail + 0.1;
        const outer = track.rail + 0.6;
        for (let row = 0; row <= rows; row += 1) {
          const y = TRACK_Y + (row / rows) * RAIL_HEIGHT;
          b.dab(at.x + nx * inner, y, at.z + nz * inner, -nx, 0, -nz, {
            tone: this.railTone(s, 2),
          });
          b.dab(at.x + nx * outer, y - TRACK_Y * 0.9, at.z + nz * outer, nx, 0, nz, {
            tone: this.railTone(s, 1),
          });
        }
        for (const across of [0.2, 0.45]) {
          const lat = track.rail + across;
          b.dab(at.x + nx * lat, TRACK_Y + RAIL_HEIGHT, at.z + nz * lat, 0, 1, 0, {
            tone: this.railTone(s, 3),
          });
        }
      }
    }
  }

  /** The start gantry: two posts, a chequered beam, five lamps. */
  private raiseGantry(): void {
    const { track } = this;
    const at = this.centre(2.5);
    const yaw = Math.atan2(at.tz, at.tx);
    const span = track.rail + 2;
    const b = new SplatBuilder(TOY_SPACING, this.set, 51).at(at.x, 0, at.z, yaw);
    const post: Coat = { tone: tone(RAMP.white, 2) };
    b.cylinder(0, GANTRY_HEIGHT / 2, span, 0.6, GANTRY_HEIGHT, post);
    b.cylinder(0, GANTRY_HEIGHT / 2, -span, 0.6, GANTRY_HEIGHT, post);
    b.box(0, GANTRY_HEIGHT + 0.6, 0, 1, 1.6, span * 2 + 1.6, {
      at: (_x, y, z) => {
        const dark = (Math.floor(z / 0.8) + Math.floor(y / 0.8)) % 2 === 0;
        return dark ? tone(RAMP.black, 1) : -1;
      },
      tone: tone(RAMP.white, 3),
    });
    b.box(-0.2, GANTRY_HEIGHT - 0.9, 0, 0.7, 1.2, 9, { tone: tone(RAMP.black, 2) });
    for (let i = 0; i < 5; i += 1) {
      const lat = (i - 2) * 1.7;
      this.lamps.push({
        x: at.x - at.tz * lat - at.tx * 0.7,
        z: at.z + at.tx * lat - at.tz * 0.7,
      });
    }
  }

  /** A striped hoop over every splat pad. */
  private raisePadGates(): void {
    const { track } = this;
    for (const pad of track.pads) {
      const at = this.centre(pad);
      const b = new SplatBuilder(TOY_SPACING, this.set, 61 + pad).at(
        at.x,
        0,
        at.z,
        Math.atan2(at.tz, at.tx),
      );
      b.arch(track.rail + 1.6, 0.6, {
        at: (_x, y, z) =>
          Math.floor((Math.atan2(y, z) / Math.PI) * 12) % 2 === 0 ? tone(RAMP.black, 2) : -1,
        tone: tone(RAMP.yellow, 2),
      });
    }
  }

  /** Is a toy `reach` wide at (x, z) clear of every stretch of road? */
  private clear(x: number, z: number, reach: number): boolean {
    const d = this.ground.distance(x, z);
    return d > this.track.rail + reach + 2.4 && d < FLOOR_REACH - reach - 4;
  }

  private scatterToys(): void {
    const { track } = this;
    const toys = TOYS[track.def.palette.room];
    const b = new SplatBuilder(TOY_SPACING, this.set, 71);
    for (let s = 6; s < track.n; s += 5.5) {
      for (const side of [-1, 1]) {
        const toy = toys[Math.floor(b.random() * toys.length)] ?? toys[0];
        const at = this.centre(s);
        const lat = side * (track.rail + toy.reach + 2.6 + b.random() ** 2 * 26);
        const x = at.x - at.tz * lat;
        const z = at.z + at.tx * lat;
        if (b.random() < 0.8 && this.clear(x, z, toy.reach)) {
          toy.bake(b.at(x, 0, z, b.random() * Math.PI * 2));
        }
      }
    }
  }
}
