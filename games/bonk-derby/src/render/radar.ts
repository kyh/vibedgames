import { edgeDistance } from "../sim/arena";
import type { Arena } from "../sim/arena";

/** One thing on the radar: where it is in the world and what it is painted in. */
export interface Blip {
  x: number;
  z: number;
  /** 0xRRGGBB. */
  rgb: number;
  /** Drawn a pixel bigger: the cars. */
  big: boolean;
}

const SIZE = 48;
const HALF = SIZE / 2;
const REACH = 46;
const FLOOR = 0xd9_c9_a8;
const RIM = 0x9c_8a_70;
const GOING = 0xe0_5a_48;
const VOID = 0x1e_1d_2d;
const EDGE = 0x15_15_20;
const LIP = 0x56_56_64;
const SELF = 0xff_f0_c8;
const OUT = 0;
const CORE = 1;
const LEDGE = 2;
const WEDGE = ["..#..", ".###.", ".###.", "#####", "##.##"] as const;

const dial = () => {
  const cells = new Uint8Array(SIZE * SIZE);

  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      const far = Math.hypot(col + 0.5 - HALF, row + 0.5 - HALF);
      const bezel = far < HALF - 1 ? 2 : 1;
      cells[row * SIZE + col] = far < HALF - 2.5 ? 3 : bezel;

      if (far >= HALF) {
        cells[row * SIZE + col] = 0;
      }
    }
  }

  return cells;
};

/**
 * A round map of the board about the player, turned the way the camera is
 * turned: up the radar is up the screen.
 */
export class Radar {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly image: ImageData;
  private readonly floor = new Uint8Array(SIZE * SIZE);
  private readonly dial = dial();
  private frame = 0;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = SIZE;
    canvas.height = SIZE;
    this.ctx = canvas.getContext("2d");
    this.image = new ImageData(SIZE, SIZE);
  }

  /**
   * `yaw` is the heading that points up the screen. `late` is the board with
   * its rim gone, `warn` the moment before, when the rim is shown going.
   */
  draw(
    arena: Arena,
    at: { x: number; z: number },
    yaw: number,
    late: boolean,
    warn: boolean,
    blips: readonly Blip[],
  ) {
    const { ctx, image } = this;

    if (!ctx) {
      return;
    }

    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const scale = (REACH * 2) / SIZE;
    this.frame += 1;

    if (this.frame % 3 === 1) {
      this.scan(arena, at, cos, sin, scale, late);
    }

    const going = warn && this.frame % 20 < 10 ? GOING : RIM;
    const tones = [VOID, FLOOR, going];
    const frame = [0, EDGE, LIP];

    for (let cell = 0; cell < SIZE * SIZE; cell += 1) {
      const part = this.dial[cell] ?? 0;
      const shown = part === 3 ? (tones[this.floor[cell] ?? OUT] ?? VOID) : (frame[part] ?? 0);
      this.put(cell, shown, part === 0 ? 0 : 255);
    }

    this.mark(at, cos, sin, scale, blips);
    this.wedge(EDGE, 3);
    this.wedge(SELF, 1);
    ctx.putImageData(image, 0, 0);
  }

  private mark(
    at: { x: number; z: number },
    cos: number,
    sin: number,
    scale: number,
    blips: readonly Blip[],
  ) {
    const rim = HALF - 5;

    for (const blip of blips) {
      const dx = blip.x - at.x;
      const dz = blip.z - at.z;
      const up = (dx * cos + dz * sin) / scale;
      const right = (-dx * sin + dz * cos) / scale;
      const far = Math.hypot(up, right);
      const pull = far > rim ? rim / far : 1;
      const size = blip.big ? 3 : 2;
      const x = HALF + right * pull;
      const y = HALF - up * pull;

      if (blip.big) {
        this.dot(x, y, EDGE, size + 2);
      }

      this.dot(x, y, blip.rgb, size);
    }
  }

  private wedge(rgb: number, size: number) {
    for (const [j, row] of WEDGE.entries()) {
      for (let i = 0; i < row.length; i += 1) {
        if (row.charAt(i) === "#") {
          this.dot(HALF - 2 + i + 0.5, HALF - 3 + j + 0.5, rgb, size);
        }
      }
    }
  }

  private scan(
    arena: Arena,
    at: { x: number; z: number },
    cos: number,
    sin: number,
    scale: number,
    late: boolean,
  ) {
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const right = (col + 0.5 - HALF) * scale;
        const up = (HALF - row - 0.5) * scale;
        const x = at.x + up * cos - right * sin;
        const z = at.z + up * sin + right * cos;
        const core = edgeDistance(arena, x, z, true) > 0;
        const rim = !core && !late && edgeDistance(arena, x, z, false) > 0;
        const off = rim ? LEDGE : OUT;
        this.floor[row * SIZE + col] = core ? CORE : off;
      }
    }
  }

  private put(cell: number, rgb: number, alpha: number) {
    const { data } = this.image;
    data[cell * 4] = Math.floor(rgb / 65_536);
    data[cell * 4 + 1] = Math.floor(rgb / 256) % 256;
    data[cell * 4 + 2] = rgb % 256;
    data[cell * 4 + 3] = alpha;
  }

  private dot(x: number, y: number, rgb: number, size: number) {
    const x0 = Math.round(x - size / 2);
    const y0 = Math.round(y - size / 2);

    for (let j = y0; j < y0 + size; j += 1) {
      for (let i = x0; i < x0 + size; i += 1) {
        if (i >= 0 && j >= 0 && i < SIZE && j < SIZE && this.dial[j * SIZE + i] === 3) {
          this.put(j * SIZE + i, rgb, 255);
        }
      }
    }
  }
}
