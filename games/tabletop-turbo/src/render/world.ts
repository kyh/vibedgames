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
import { KITS } from "./toys";
import type { Toy } from "./toys";

/** Height of the track's surface above the floor. */
export const TRACK_Y = 0.2;

const FLOOR_SPACING = 0.62;
const TRACK_SPACING = 0.34;
const TOY_SPACING = 0.38;
const RAIL_HEIGHT = 1.1;
const GANTRY_HEIGHT = 7.5;
/**
 * The room. Walls face inwards and a splat facing away from the camera is not
 * drawn, so the tabletop camera, which sits outside the room, sees in through
 * the two near walls like a dolls' house. Below: half the room's side, how
 * coarsely the far floor and walls are dabbed, and how tall the walls stand.
 */
const ROOM_HALF = 200;
const ROOM_SPACING = 1.7;
const WALL_HEIGHT = 46;

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
    return tone(RAMP.tile, 1);
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
  const fleck = hash(Math.floor(x * 1.5), Math.floor(z * 1.5)) > 0.96;
  if (fleck) {
    return tone(RAMP.carpet, 3);
  }
  return tone(RAMP.carpet, light ? 2 : 1);
};

const FLOORS: Record<Room, (x: number, z: number) => number> = {
  bedroom: bedroomFloor,
  kitchen: kitchenFloor,
  playroom: playroomFloor,
};

const WALLPAPER: Record<Room, number> = {
  bedroom: RAMP.peach,
  kitchen: RAMP.mint,
  playroom: RAMP.lilac,
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
    this.layRoom();
    this.layTrack();
    this.layRails();
    this.raiseGantry();
    this.raisePadGates();
    this.placeSetPieces();
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
    const under = this.track.rail + 0.3;
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

  /** The rest of the room: coarse floor out to four walls with a skirting board and striped paper. */
  private layRoom(): void {
    const { room } = this.track.def.palette;
    const floor = FLOORS[room];
    const paper = WALLPAPER[room];
    const b = new SplatBuilder(ROOM_SPACING, this.set, 23);
    for (let z = -ROOM_HALF; z < ROOM_HALF; z += ROOM_SPACING) {
      for (let x = -ROOM_HALF; x < ROOM_HALF; x += ROOM_SPACING) {
        if (this.ground.distance(x, z) >= FLOOR_REACH - 1) {
          b.dab(x, 0, z, 0, 1, 0, { tone: floor(x, z) });
        }
      }
    }
    const wall = {
      at: (x: number, y: number, z: number): number => {
        if (y < 5) {
          return tone(RAMP.white, 3);
        }
        return Math.floor((x + z) / 9) % 2 === 0 ? tone(paper, 3) : tone(paper, 2);
      },
      tone: tone(paper, 2),
    };
    const span = ROOM_HALF * 2;
    for (const side of [-1, 1]) {
      b.rect(
        [-ROOM_HALF, 0, side * ROOM_HALF],
        [span, 0, 0],
        [0, WALL_HEIGHT, 0],
        [0, 0, -side],
        wall,
      );
      b.rect(
        [side * ROOM_HALF, 0, -ROOM_HALF],
        [0, 0, span],
        [0, WALL_HEIGHT, 0],
        [-side, 0, 0],
        wall,
      );
    }
  }

  /** The tone of the track's surface `lat` metres off the centreline at lap position `s`. */
  private surface(s: number, lat: number): number {
    const { track } = this;
    const off = Math.abs(lat);
    const half = track.halfWidth;
    if (off > half) {
      // The shoulder: a rumble strip, then darker plastic out to the rail.
      const stripe = Math.floor(s / 2) % 2 === 0 ? tone(RAMP.track, 4) : tone(RAMP.track, 0);
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
        return wrap(past + off * 0.5, 1.5) < 0.75 ? tone(RAMP.track, 4) : tone(RAMP.track, 0);
      }
    }
    if (off < 0.24 && Math.floor(s / 3) % 2 === 0) {
      return tone(RAMP.track, 3);
    }
    if (off > half - 0.75 && off < half - 0.3) {
      return tone(RAMP.track, 4);
    }
    // Where two lengths of track click together.
    if (wrap(s, 16) < 0.4) {
      return tone(RAMP.track, 1);
    }
    // Worn plastic: lighter scuffs in patches, so the surface is dabs, not a slab.
    return hash(Math.floor(s / 0.9), Math.floor(lat / 0.7)) > 0.9
      ? tone(RAMP.track, 3)
      : tone(RAMP.track, 2);
  }

  /** Road takes paint; an armed pad's chevrons run with light. */
  private flagsAt(s: number, lat: number): number {
    const { track } = this;
    if (Math.abs(lat) > track.halfWidth) {
      return 0;
    }
    const onPad = track.pads.some((pad) => {
      const past = lapGap(s, pad, track.n);
      return past > -1 && past < 3 && Math.abs(lat) < track.halfWidth * 0.75;
    });
    return onPad ? FLAG.paintable + FLAG.pulse : FLAG.paintable;
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
            flags: this.flagsAt(s, off),
            tone: this.surface(s, off),
          },
        );
      }
    }
  }

  /** The rail's colour at `s`: orange on the straights, light and dark chevrons through a bend. */
  private railTone(s: number, step: number): number {
    const bend = Math.abs(this.track.curve[Math.floor(s) % this.track.n] ?? 0);
    if (bend > 0.018) {
      return Math.floor(s / 2.5) % 2 === 0
        ? tone(RAMP.track, step - 1)
        : tone(RAMP.track, Math.min(4, step + 2));
    }
    return wrap(s, 16) < 0.6 ? tone(RAMP.track, step + 1) : tone(RAMP.track, step);
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
          Math.floor((Math.atan2(y, z) / Math.PI) * 12) % 2 === 0 ? tone(RAMP.track, 0) : -1,
        tone: tone(RAMP.track, 4),
      });
    }
  }

  /**
   * Is a toy at (x, z) clear of every stretch of road, and of the camera's
   * line to it? The tabletop camera looks down from +x +z, so anything tall
   * hides the ground behind it for about 1.7 times its height.
   */
  private clear(x: number, z: number, toy: Toy): boolean {
    const edge = this.track.rail + toy.reach + 2.4;
    const d = this.ground.distance(x, z);
    if (d < edge || d > FLOOR_REACH - toy.reach - 4) {
      return false;
    }
    // Checked down the middle and along both edges of its shadow on the screen.
    for (const across of [-toy.reach, 0, toy.reach]) {
      const ox = x + across * Math.SQRT1_2;
      const oz = z - across * Math.SQRT1_2;
      for (let back = 0; back <= toy.height * 1.7 + toy.reach; back += 3) {
        const behind = this.ground.distance(ox - back * Math.SQRT1_2, oz - back * Math.SQRT1_2);
        if (behind < this.track.rail + 2) {
          return false;
        }
      }
    }
    return true;
  }

  /** Small toys in loose clusters along the road, on the far side of it more often than the near. */
  private scatterToys(): void {
    const { track } = this;
    const kit = KITS[track.def.palette.room];
    const b = new SplatBuilder(TOY_SPACING, this.set, 71);
    for (let s = 9; s < track.n; s += 7) {
      // Clusters, then bare floor: every third stretch gets nothing.
      const busy = Math.floor(s / 42) % 4 !== 3;
      for (const side of [-1, 1]) {
        const toy = kit.toys[Math.floor(b.random() * kit.toys.length)] ?? kit.toys[0];
        const at = this.centre(s);
        const lat = side * (track.rail + (toy?.reach ?? 2) + 2.6 + b.random() ** 2 * 18);
        const x = at.x - at.tz * lat;
        const z = at.z + at.tx * lat;
        if (toy && busy && b.random() < 0.75 && this.clear(x, z, toy)) {
          toy.bake(b.at(x, 0, z, b.random() * Math.PI * 2), kit.colours);
        }
      }
    }
  }

  /** The room's big pieces: tried at spots round the circuit until each finds floor it does not block. */
  private placeSetPieces(): void {
    const { track } = this;
    const kit = KITS[track.def.palette.room];
    const b = new SplatBuilder(TOY_SPACING, this.set, 91);
    for (const [i, piece] of kit.setPieces.entries()) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const s = ((i + 0.3) / kit.setPieces.length) * track.n + attempt * 9;
        const at = this.centre(s % track.n);
        const side = attempt % 2 === 0 ? 1 : -1;
        const lat = side * (track.rail + piece.reach + 5 + (attempt % 5) * 4);
        const x = at.x - at.tz * lat;
        const z = at.z + at.tx * lat;
        if (this.clear(x, z, piece)) {
          piece.bake(b.at(x, 0, z, Math.round(b.random() * 4) * (Math.PI / 8)), kit.colours);
          // Nothing else lands on top of it.
          this.ground.block(x, z, piece.reach + 3);
          break;
        }
      }
    }
  }
}
